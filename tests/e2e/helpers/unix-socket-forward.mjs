import { connect, createServer } from "node:net";

const [local, remote] = process.argv[2].split(":");
createServer((client) => {
  const host = connect(remote);
  client.pipe(host);
  host.pipe(client);
  client.on("close", () => host.destroy());
  client.on("error", () => host.destroy());
  host.on("close", () => client.destroy());
  host.on("error", () => client.destroy());
}).listen(local);
