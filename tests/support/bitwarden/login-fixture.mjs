import http from "node:http";

// Invented local login page for genuine extension save/autofill tests.
// Never echoes submitted passwords or writes credentials to disk.
export async function startLoginFixture() {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST" && request.url === "/login") {
      request.resume();
      response.writeHead(303, { Location: "/success" });
      response.end();
      return;
    }
    response.end(
      request.url === "/success"
        ? `<!doctype html><title>Fixture signed in</title><h1>Signed in to fixture</h1><a href="/">Sign out</a>`
        : `<!doctype html><title>Cod fixture login</title><h1>Cod fixture login</h1><form method="post" action="/login"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(18782, "127.0.0.1", resolve);
  });
  return {
    url: "http://localhost:18782",
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
