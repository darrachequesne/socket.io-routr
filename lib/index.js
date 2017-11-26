"use strict";

const debug = require("debug")("socket.io-routr:index");
const http = require("http");
const httpProxy = require("http-proxy");
const url = require("url");

const SID_REGEX = /"sid":"([\w-]{20})"/;

module.exports = function createRouter(redisClient, clients, options) {
  if (!redisClient) {
    throw new Error("'redisClient' is mandatory!");
  }
  if (!Array.isArray(clients)) {
    throw new Error("'clients' array is mandatory!");
  }

  const opts = Object.assign(
    {
      path: "/socket.io/",
      keyPrefix: "socket.io#",
      keyExpiry: 60 // 1 minute
    },
    options
  );

  debug("starting router with options %j", opts);

  const proxyServer = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true
  });

  proxyServer.on("proxyRes", (proxyRes, req) => {
    if (!req["ROUTER_TRACK_ID"]) return;

    let body = "";
    proxyRes.on("data", chunk => {
      body += chunk;
    });

    proxyRes.on("end", () => {
      let sid = SID_REGEX.exec(body);
      if (!(sid && sid.length > 1)) {
        debug("sid not found in %s", body);
        return;
      }
      let target = req["ROUTER_TARGET"];
      debug("binding sid %s with target %s", sid[1], target);
      redisClient.set(
        `${opts.keyPrefix}${sid[1]}`,
        target,
        "EX",
        opts.keyExpiry,
        err => {
          if (err) debug("error while creating binding: %s", err);
        }
      );
    });
  });

  proxyServer.on("error", (err, req) => {
    let sid = req["ROUTER_SID"];
    if (!sid) return;

    debug("error, unbinding sid %s", sid);
    redisClient.del(`${opts.keyPrefix}${sid}`, err => {
      if (err) debug("error while deleting binding: %s", err);
    });
  });

  const getTarget = req => {
    let query = url.parse(req.url, true).query;

    if (!Object.prototype.hasOwnProperty.call(query, "sid")) {
      let connectedClients = clients.filter(client => client.connected);
      if (connectedClients.length) {
        let target =
          connectedClients[Math.floor(Math.random() * connectedClients.length)]
            .io.uri;
        debug("first request, routing to %s", target);
        req["ROUTER_TRACK_ID"] = true;
        req["ROUTER_TARGET"] = target;
        return Promise.resolve(target);
      } else {
        return Promise.reject(new Error("no node available"));
      }
    }

    req["ROUTER_SID"] = query.sid;

    return new Promise((resolve, reject) => {
      redisClient.get(`${opts.keyPrefix}${query.sid}`, (err, target) => {
        if (err) {
          return reject(err);
        }
        if (!target) {
          return reject(new Error("unknown binding"));
        }
        debug(`sid ${query.sid} is bound with ${target}`);
        resolve(target);

        redisClient.expire(
          `${opts.keyPrefix}${query.sid}`,
          opts.keyExpiry,
          err => {
            if (err) debug("error while delaying expiry: %s", err);
          }
        );
      });
    });
  };

  const server = http.createServer((req, res) => {
    debug("new request %s %s", req.method, req.url);

    if (!req.url.startsWith(opts.path)) {
      debug("unknown path: %s", req.url);
      res.writeHead(400);
      res.end();
      return;
    }

    getTarget(req)
      .then(target => {
        debug("routing to %s", target);
        proxyServer.web(req, res, { target: target });
      })
      .catch(err => {
        debug("error while routing: %s", err);
        res.writeHead(400);
        res.end();
      });
  });

  server.on("upgrade", (req, socket) => {
    debug("new request (ws) %s %s", req.method, req.url);

    if (!req.url.startsWith(opts.path)) {
      debug("unknown path (ws): %s", req.url);
      socket.write(
        "HTTP/1.1 400 Bad Request\r\n" +
          "Connection: close\r\n" +
          "Content-type: text/html\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n"
      );
      socket.end();
      return;
    }

    getTarget(req)
      .then(target => {
        debug("routing (ws) to %s", target);
        proxyServer.ws(req, socket, { target: target });
      })
      .catch(err => {
        debug("error while routing (ws): %s", err);
        socket.write(
          "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n" +
            "Content-type: text/html\r\n" +
            "Content-Length: 0\r\n" +
            "\r\n"
        );
        socket.end();
      });
  });

  return server;
};
