/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var extend = require("extend");

var promiseutil = require("../promiseutil");
var IrcHandler = require("./IrcHandler.js");
var MatrixHandler = require("./MatrixHandler.js");
var MemberListSyncer = require("./MemberListSyncer.js");
var IdentGenerator = require("../irc/IdentGenerator.js");
var Ipv6Generator = require("../irc/Ipv6Generator.js");
var IrcServer = require("../irc/IrcServer.js");
var ClientPool = require("../irc/ClientPool");
var IrcEventBroker = require("../irc/IrcEventBroker");
var BridgedClient = require("../irc/BridgedClient");
var IrcUser = require("../models/IrcUser");
var IrcClientConfig = require("../models/IrcClientConfig");
var BridgeRequest = require("../models/BridgeRequest");
var stats = require("../config/stats");
var DataStore = require("../DataStore");
var log = require("../logging").get("IrcBridge");
var Bridge = require("matrix-appservice-bridge").Bridge;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;

const DELAY_TIME_MS = 10 * 1000;
const DEAD_TIME_MS = 5 * 60 * 1000;
const ACTION_TYPE_TO_MSGTYPE = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

function IrcBridge(config, registration) {
    this.config = config;
    this.registration = registration;
    this.ircServers = [];
    this.domain = null; // String
    this.appServiceUserId = null; // String
    this.memberListSyncers = {
    //  domain: MemberListSyncer
    };

    // Dependency graph
    this.matrixHandler = new MatrixHandler(this);
    this.ircHandler = new IrcHandler(this);
    this._clientPool = new ClientPool(this);
    var dirPath = this.config.ircService.databaseUri.substring("nedb://".length);
    this._bridge = new Bridge({
        registration: this.registration,
        homeserverUrl: this.config.homeserver.url,
        domain: this.config.homeserver.domain,
        controller: this,
        roomStore: dirPath + "/rooms.db",
        userStore: dirPath + "/users.db",
        disableContext: true,
        suppressEcho: false, // we use our own dupe suppress for now
        queue: {
            type: "none",
            perRequest: false
        },
        intentOptions: {
            clients: {
                dontCheckPowerLevel: true
            },
            bot: {
                dontCheckPowerLevel: true
            }
        }
    });

    this._ircEventBroker = new IrcEventBroker(
        this._bridge, this._clientPool, this.ircHandler
    );
    this._dataStore = null; // requires Bridge to have loaded the databases
    this._identGenerator = null; // requires inited data store
    this._ipv6Generator = null; // requires inited data store
    this._startedUp = false;
}

IrcBridge.prototype.getAppServiceUserId = function() {
    return this.appServiceUserId;
};

IrcBridge.prototype.getStore = function() {
    return this._dataStore;
};

IrcBridge.prototype.getAppServiceBridge = function() {
    return this._bridge;
};

IrcBridge.prototype.getClientPool = function() {
    return this._clientPool;
};

IrcBridge.prototype.createBridgedClient = function(ircClientConfig, matrixUser, isBot) {
    let server = this.ircServers.filter((s) => {
        return s.domain === ircClientConfig.getDomain();
    })[0];
    if (!server) {
        throw new Error(
            "Cannot create bridged client for unknown server " +
            ircClientConfig.getDomain()
        );
    }
    return new BridgedClient(
        server, ircClientConfig, matrixUser, isBot,
        this._ircEventBroker, this._identGenerator, this._ipv6Generator
    );
};

IrcBridge.prototype.run = Promise.coroutine(function*(port) {
    yield this._bridge.loadDatabases();
    this._dataStore = new DataStore(this._bridge.getUserStore(), this._bridge.getRoomStore());
    yield this._dataStore.removeConfigMappings();
    this._identGenerator = new IdentGenerator(this._dataStore);
    this._ipv6Generator = new Ipv6Generator(this._dataStore);

    // maintain a list of IRC servers in-use
    let serverDomains = Object.keys(this.config.ircService.servers);
    for (var i = 0; i < serverDomains.length; i++) {
        let domain = serverDomains[i];
        let completeConfig = extend(
            true, {}, IrcServer.DEFAULT_CONFIG, this.config.ircService.servers[domain]
        );
        let server = new IrcServer(domain, completeConfig);
        // store the config mappings in the DB to keep everything in one place.
        yield this._dataStore.setServerFromConfig(server, completeConfig);
        this.ircServers.push(server);
    }

    if (this.ircServers.length === 0) {
        throw new Error("No IRC servers specified.");
    }

    // run the bridge (needs to be done prior to configure IRC side)
    yield this._bridge.run(port);
    this._bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        this.onLog("[" + req.getId() + "] DELAYED (" + req.getDuration() + "ms)");
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "delay", req.getDuration());
    }, DELAY_TIME_MS);
    this._bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        this.onLog("[" + req.getId() + "] DEAD (" + req.getDuration() + "ms)");
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "fail", req.getDuration());
    }, DEAD_TIME_MS);
    this._bridge.getRequestFactory().addDefaultResolveCallback((req, res) => {
        if (res === BridgeRequest.ERR_VIRTUAL_USER) {
            log.debug("[" + req.getId() + "] IGNORE virtual user");
            return; // these aren't true successes so don't skew graphs
        }
        else if (res === BridgeRequest.ERR_NOT_MAPPED) {
            log.debug("[" + req.getId() + "] IGNORE not mapped");
            return; // these aren't true successes so don't skew graphs
        }
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "success", req.getDuration());
    });
    this._bridge.getRequestFactory().addDefaultRejectCallback((req) => {
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "fail", req.getDuration());
    });

    if (this.config.appService) {
        console.warn(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Remove this
            field from the config file to remove this warning.

            This release will use values from this config field. This will produce
            a fatal error in a later release.`
        );
        this.domain = this.config.appService.homeserver.domain;
        this.appServiceUserId = (
            "@" + (
                this.config.appService.localpart ||
                this.registration.getSenderLocalpart() ||
                IrcBridge.DEFAULT_LOCALPART
            ) + ":" +
            this.domain
        );
    }
    else {
        if (!this.registration.getSenderLocalpart() ||
                !this.registration.getAppServiceToken()) {
            throw new Error(
                "FATAL: Registration file is missing a sender_localpart and/or AS token."
            );
        }
        this.domain = this.config.homeserver.domain;
        this.appServiceUserId = (
            "@" + this.registration.getSenderLocalpart() + ":" +
            this.domain
        );
    }

    // start things going
    log.info("Joining mapped Matrix rooms...");
    yield this._joinMappedMatrixRooms();
    log.info("Syncing relevant membership lists...");
    let memberlistPromises = [];
    this.ircServers.forEach((server) => {
        // TODO reduce deps required to make MemberListSyncers.
        // TODO Remove injectJoinFn bodge
        this.memberListSyncers[server.domain] = new MemberListSyncer(
            this, this._bridge.getBot(), server, this.appServiceUserId,
            (roomId, joiningUserId, isFrontier) => {
                var req = new BridgeRequest(
                    this._bridge.getRequestFactory().newRequest(), false
                );
                var target = new MatrixUser(joiningUserId);
                // inject a fake join event which will do M->I connections and
                // therefore sync the member list
                return this.matrixHandler.onJoin(req, {
                    event_id: "$fake:membershiplist",
                    room_id: roomId,
                    state_key: joiningUserId,
                    user_id: joiningUserId,
                    content: {
                        membership: "join"
                    },
                    _injected: true,
                    _frontier: isFrontier
                }, target);
            }
        );
        memberlistPromises.push(
            this.memberListSyncers[server.domain].sync()
        );
    });
    log.info("Connecting to IRC networks...");
    yield this.connectToIrcNetworks();
    yield Promise.all(memberlistPromises);
    log.info("Startup complete.");
    this._startedUp = true;
});

IrcBridge.prototype.isStartedUp = function() {
    return this._startedUp;
};

IrcBridge.prototype._joinMappedMatrixRooms = Promise.coroutine(function*() {
    let roomIds = yield this.getStore().getRoomIdsFromConfig();
    let promises = roomIds.map((roomId) => {
        return this._bridge.getIntent().join(roomId);
    });
    yield promiseutil.allSettled(promises);
});

IrcBridge.prototype.sendMatrixAction = function(room, from, action, req) {
    if (req) {
        req.log.info("sendMatrixAction -> %s", JSON.stringify(action));
    }
    let msgtype = ACTION_TYPE_TO_MSGTYPE[action.type];
    let intent = this._bridge.getIntent(from.userId);
    if (msgtype) {
        if (action.htmlText) {
            return intent.sendMessage(room.getId(), {
                msgtype: msgtype,
                body: (
                    action.text || action.htmlText.replace(/(<([^>]+)>)/ig, "") // strip html tags
                ),
                format: "org.matrix.custom.html",
                formatted_body: action.htmlText
            });
        }
        return intent.sendMessage(room.getId(), {
            msgtype: msgtype,
            body: action.text
        });
    }
    else if (action.type === "topic") {
        return intent.setRoomTopic(room.getId(), action.text);
    }
    return Promise.reject(new Error("Unknown action: " + action.type));
};

IrcBridge.prototype.getMatrixUser = Promise.coroutine(function*(ircUser) {
    let matrixUser = null;
    let userLocalpart = ircUser.server.getUserLocalpart(ircUser.nick);
    let displayName = ircUser.server.getDisplayNameFromNick(ircUser.nick);

    try {
        matrixUser = yield this.getStore().getMatrixUserByLocalpart(userLocalpart);
        if (matrixUser) {
            return matrixUser;
        }
    }
    catch (e) {
        // user does not exist. Fall through.
    }

    let userIntent = this._bridge.getIntentFromLocalpart(userLocalpart);
    yield userIntent.setDisplayName(displayName); // will also register this user
    matrixUser = new MatrixUser(userIntent.getClient().credentials.userId);
    matrixUser.setDisplayName(displayName);
    yield this.getStore().storeMatrixUser(matrixUser);
    return matrixUser;
});

IrcBridge.prototype.onEvent = function(request, context) {
    request.outcomeFrom(this._onEvent(request, context));
};

IrcBridge.prototype._onEvent = Promise.coroutine(function*(baseRequest, context) {
    var event = baseRequest.getData();
    var request = new BridgeRequest(baseRequest, false);
    if (event.type === "m.room.message" || event.type === "m.room.topic") {
        yield this.matrixHandler.onMessage(request, event)
    }
    else if (event.type === "m.room.member") {
        if (!event.content || !event.content.membership) {
            return;
        }
        var target = new MatrixUser(event.state_key);
        var sender = new MatrixUser(event.user_id);
        if (event.content.membership === "invite") {
            yield this.matrixHandler.onInvite(request, event, sender, target);
        }
        else if (event.content.membership === "join") {
            yield this.matrixHandler.onJoin(request, event, target);
        }
        else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
            yield this.matrixHandler.onLeave(request, event, target);
        }
    }
});

IrcBridge.prototype.onUserQuery = Promise.coroutine(function*(matrixUser) {
    var baseRequest = this._bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onUserQuery(request, matrixUser.getId());
    // TODO: Lean on the bridge lib more
    return null; // don't provision, we already do atm
});

IrcBridge.prototype.onAliasQuery = Promise.coroutine(function*(alias, aliasLocalpart) {
    var baseRequest = this._bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onAliasQuery(request, alias);
    // TODO: Lean on the bridge lib more
    return null; // don't provision, we already do atm
});

IrcBridge.prototype.onLog = function(line, isError) {
    if (isError) {
        log.error(line);
    }
    else {
        log.info(line);
    }
};

IrcBridge.prototype.getIrcUserFromCache = function(server, userId) {
    return this._clientPool.getBridgedClientByUserId(server, userId);
};

IrcBridge.prototype.getBridgedClientsForUserId = function(userId) {
    return this._clientPool.getBridgedClientsForUserId(userId);
};

IrcBridge.prototype.getServer = function(domainName) {
    for (var i = 0; i < this.ircServers.length; i++) {
        var server = this.ircServers[i];
        if (server.domain === domainName) {
            return server;
        }
    }
    return null;
};

IrcBridge.prototype.getServers = function() {
    return this.ircServers || [];
};

// TODO: Check how many of the below functions need to reside on IrcBridge still.

IrcBridge.prototype.aliasToIrcChannel = function(alias) {
    var ircServer = null;
    var servers = this.getServers();
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        if (server.claimsAlias(alias)) {
            ircServer = server;
            break;
        }
    }
    if (!ircServer) {
        return {};
    }
    return {
        server: ircServer,
        channel: ircServer.getChannelFromAlias(alias)
    };
};

IrcBridge.prototype.matrixToIrcUser = function(user) {
    var server = null;
    var servers = this.getServers();
    for (var i = 0; i < servers.length; i++) {
        if (servers[i].claimsUserId(user.getId())) {
            server = servers[i];
            break;
        }
    }
    var ircInfo = {
        server: server,
        nick: server ? server.getNickFromUserId(user.getId()) : null
    };
    if (!ircInfo.server || !ircInfo.nick) {
        return Promise.reject(
            new Error("User ID " + user.getId() + " doesn't map to a server/nick")
        );
    }
    return Promise.resolve(new IrcUser(ircInfo.server, ircInfo.nick, true));
};

IrcBridge.prototype.trackChannel = function(server, channel) {
    return this.getBotClient(server).then(function(client) {
        return client.joinChannel(channel);
    }).catch(log.logErr);
};

IrcBridge.prototype.connectToIrcNetworks = function() {
    return promiseutil.allSettled(this.ircServers.map((server) => {
        return this._loginToServer(server);
    }));
};

IrcBridge.prototype._loginToServer = Promise.coroutine(function*(server) {
    var uname = "matrixirc";
    var bridgedClient = this.getIrcUserFromCache(server, uname);
    if (!bridgedClient) {
        var botIrcConfig = server.createBotIrcClientConfig(uname);
        bridgedClient = this._clientPool.createIrcClient(botIrcConfig, null, true);
        log.debug(
            "Created new bot client for %s (disabled=%s): %s",
            server.domain, bridgedClient.disabled, bridgedClient._id
        );
    }
    var chansToJoin = [];
    if (server.shouldJoinChannelsIfNoUsers()) {
        chansToJoin = yield this.getStore().getTrackedChannelsForServer(server.domain);
    }
    else {
        chansToJoin = yield this.memberListSyncers[server.domain].getChannelsToJoin();
    }
    log.info("Bot connecting to %s (%s channels) => %s",
        server.domain, chansToJoin.length, JSON.stringify(chansToJoin)
    );
    try {
        yield bridgedClient.connect();
    }
    catch (err) {
        log.error("Bot failed to connect to %s : %s - Retrying....",
            server.domain, JSON.stringify(err));
        log.logErr(err);
        return this._loginToServer(server);
    }
    this._clientPool.addBot(server, bridgedClient);
    var num = 1;
    chansToJoin.forEach((c) => {
        // join a channel every 500ms. We stagger them like this to
        // avoid thundering herds
        setTimeout(function() {
            // catch this as if this rejects it will hard-crash
            // since this is a new stack frame which will bubble
            // up as an uncaught exception.
            bridgedClient.joinChannel(c).catch((e) => {
                log.error("Failed to join channel:: %s", c);
                log.error(e);
            });
        }, 500 * num);
        num += 1;
    });
});

IrcBridge.prototype.checkNickExists = function(server, nick) {
    log.info("Querying for nick %s on %s", nick, server.domain);
    return this.getBotClient(server).then(function(client) {
        return client.whois(nick);
    });
};

IrcBridge.prototype.joinBot = function(ircRoom) {
    return this.getBotClient(ircRoom.server).then((client) => {
        return client.joinChannel(ircRoom.channel);
    }).catch((e) => {
        log.error("Bot failed to join channel %s", ircRoom.channel);
    });
};

IrcBridge.prototype.partBot = function(ircRoom) {
    log.info(
        "Parting bot from %s on %s", ircRoom.channel, ircRoom.server.domain
    );
    return this.getBotClient(ircRoom.server).then((client) => {
        return client.leaveChannel(ircRoom.channel);
    });
};

IrcBridge.prototype.getBridgedClient = Promise.coroutine(function*(server, userId,
                                                         displayName) {
    var bridgedClient = this.getIrcUserFromCache(server, userId);
    if (bridgedClient) {
        log.debug("Returning cached bridged client %s", userId);
        return bridgedClient;
    }

    var nick = server.getNick(userId, displayName);
    var mxUser = new MatrixUser(userId);
    mxUser.setDisplayName(displayName);
    var ircClientConfig = IrcClientConfig.newConfig(mxUser, server.domain, nick);

    log.debug(
        "Creating virtual irc user with nick %s for %s (display name %s)",
        nick, userId, displayName
    );
    bridgedClient = this._clientPool.createIrcClient(ircClientConfig, mxUser, false);

    // check the database for stored config information for this irc client
    // including username, custom nick, nickserv password, etc.
    let storedConfig = yield this.getStore().getIrcClientConfig(userId, server.domain);
    if (storedConfig) {
        log.debug("Configuring IRC user from store => " + storedConfig);
        bridgedClient.setClientConfig(storedConfig);
    }

    try {
        yield bridgedClient.connect();
        if (!storedConfig) {
            yield this.getStore().storeIrcClientConfig(ircClientConfig);
        }
        return bridgedClient;
    }
    catch (err) {
        log.error("Couldn't connect virtual user %s to %s : %s",
                nick, server.domain, JSON.stringify(err));
        throw err;
    }
});

IrcBridge.prototype.sendIrcAction = function(ircRoom, bridgedClient, action) {
    log.info(
        "Sending msg in %s as %s", ircRoom.channel, bridgedClient.nick
    );
    return bridgedClient.sendAction(ircRoom, action);
};

IrcBridge.prototype.getBotClient = function(server) {
    var botClient = this._clientPool.getBot(server);
    if (botClient) {
        return Promise.resolve(botClient);
    }
    return this._loginToServer(server).then(() => {
        return this._clientPool.getBot(server);
    });
}

IrcBridge.DEFAULT_LOCALPART = "appservice-irc";

module.exports = IrcBridge;
