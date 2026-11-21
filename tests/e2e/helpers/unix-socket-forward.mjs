import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const [local, remote] = process.argv[2].split(":");
const dropReply = process.argv[3];
const holdRequest = dropReply && dropReply + ".hold";
let withholding = false;
createServer((client) => {
  const host = connect(remote);
  if (dropReply) {
    let watch = false;
    let withheld;
    forward(client, host, (line) => {
      const frame = JSON.parse(line);
      watch ||= frame.op === "workspace.watch";
      const operation = frame.op ?? frame.request?.op;
      if (
        holdRequest &&
        existsSync(holdRequest) &&
        operation === readFileSync(holdRequest, "utf8")
      ) {
        writeFileSync(holdRequest + ".seen", "");
        const release = setInterval(() => {
          if (existsSync(holdRequest)) return;
          clearInterval(release);
          host.write(line + "\n");
        }, 25);
        host.once("close", () => clearInterval(release));
        return false;
      }
      if (
        existsSync(dropReply) &&
        operation === readFileSync(dropReply, "utf8")
      ) {
        unlinkSync(dropReply);
        withholding = true;
        withheld = frame.type === "review-command" ? frame.id : true;
      }
      return true;
    });
    forward(host, client, (line) => {
      const frame = JSON.parse(line);
      if (
        (withheld === true && frame.ok !== undefined) ||
        (withheld !== undefined &&
          frame.type === "review-reply" &&
          frame.id === withheld)
      )
        process.exit(0);
      return !(watch && withholding && frame.type === "state");
    });
  } else {
    client.pipe(host);
    host.pipe(client);
  }
  client.on("close", () => host.destroy());
  client.on("error", () => host.destroy());
  host.on("close", () => client.destroy());
  host.on("error", () => client.destroy());
}).listen(local);

function forward(from, to, beforeWrite) {
  let pending = "";
  from.setEncoding("utf8").on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (beforeWrite(line)) to.write(line + "\n");
    }
  });
  from.on("end", () => to.end());
}
