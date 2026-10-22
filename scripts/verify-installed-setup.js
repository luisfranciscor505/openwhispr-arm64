// Inspect only the installed app's onboarding UI through a temporary local
// DevTools connection. Do not read account tokens, account data, or page text.
const fs = require("fs");
const path = require("path");
const port = Number(process.argv[2] || 9337);
const output = path.resolve(
  __dirname,
  "../artifacts/windows-arm64/onboarding-setup-verification.json"
);
let nextId = 0;
async function inspect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not inspect installed app")), {
      once: true,
    });
  });
  try {
    const id = ++nextId;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(new Error("App inspection timed out"));
      }, 5000);
      function receive(event) {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        resolve(message);
      }
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            returnByValue: true,
            expression: `(() => { const text = document.body?.innerText || ''; return {
          setupPage: text.includes('Elige tu configuración') || text.includes('Choose your OpenWhispr setup'),
          blockedSetup: text.includes('No hay ninguna opción de configuración disponible') || text.includes('No setup option is available'),
          localChoice: text.includes('En tu dispositivo') || text.includes('On your device'),
          cloudChoice: text.includes('OpenWhispr Cloud'),
        }; })()`,
          },
        })
      );
    });
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
}
async function verify() {
  const deadline = Date.now() + 45000;
  let pages = [];
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => []); // the app may still be starting its local inspection endpoint
    pages = [];
    for (const target of targets.filter(
      (target) => target.type === "page" && /openwhispr\/resources\/app\.asar\//i.test(target.url)
    ))
      pages.push(await inspect(target));
    if (pages.some((page) => page?.setupPage && page.localChoice && !page.blockedSetup)) {
      fs.writeFileSync(
        output,
        JSON.stringify({ date: new Date().toISOString(), success: true, pages }, null, 2)
      );
      console.log("Installed onboarding offers local setup");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fs.writeFileSync(
    output,
    JSON.stringify({ date: new Date().toISOString(), success: false, pages }, null, 2)
  );
  throw new Error("Installed app has not displayed an available local setup option");
}
verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
