"use strict";

const createRouter = require("..");
const Server = require("socket.io");
const Client = require("socket.io-client");
const redis = require("redis");

let server1, server2, router, routerClient1, routerClient2, redisClient;
let PORT = 40000;

function createSocketIOServer() {
  let server = new Server(++PORT);
  server.on("connection", socket => {
    socket.on("hello", cb => cb("hello!"));
  });
  let client = new Client(`http://localhost:${PORT}`);

  return [server, client];
}

describe("socket.io-routr", function() {
  this.timeout(10000);

  beforeEach(done => {
    redisClient = redis.createClient(6379, "localhost");
    [server1, routerClient1] = createSocketIOServer();
    [server2, routerClient2] = createSocketIOServer();

    router = createRouter(redisClient, [routerClient1, routerClient2]);
    router.listen(++PORT);

    setTimeout(done, 200);
  });

  afterEach(() => {
    server1.close();
    server2.close();
    router.close();
    routerClient1.close();
    routerClient2.close();
    redisClient.quit();
  });

  it("should work when using both polling and websocket", done => {
    let client = new Client(`http://localhost:${PORT}`);

    client.io.engine.on("upgrade", () => {
      client.emit("hello", () => {
        client.close();
        done();
      });
    });
  });

  it("should work when using only polling", done => {
    let client = new Client(`http://localhost:${PORT}`, {
      transports: ["polling"]
    });

    client.emit("hello", () => {
      client.close();
      done();
    });
  });

  it("should work when using only websocket", done => {
    let client = new Client(`http://localhost:${PORT}`, {
      transports: ["websocket"]
    });

    client.emit("hello", () => {
      client.close();
      done();
    });
  });
});
