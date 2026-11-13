// Demo plugin client app. It only talks through the per-iframe MessageChannel.
const button = document.getElementById("tip");
const result = document.getElementById("result");

const bridgeReady = new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "bulletin:bridge:init") {
      return;
    }

    const port = event.ports[0];

    if (port === undefined || typeof event.data.token !== "string") {
      return;
    }

    let nextId = 0;
    const pending = new Map();
    port.onmessage = (message) => {
      const value = message.data;
      if (value?.type !== "bulletin:bridge:result" || value.token !== event.data.token) {
        return;
      }
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    };
    port.start();

    const call = (body) =>
      new Promise((done) => {
        const id = `tip-${String(++nextId)}`;
        pending.set(id, done);
        port.postMessage({ ...body, token: event.data.token, id });
      });

    resolve({ call, port, token: event.data.token });
    port.postMessage({ type: "resize", token: event.data.token, height: 80 });
  });
});

async function tip() {
  const bridge = await bridgeReady;
  const response = await bridge.call({ type: "route", path: "tip", method: "GET" });
  const body = response?.data?.body ?? "";
  result.textContent = body || "no response";
  // A successful viewer-aware route call reports a distinctive height, so the host E2E can
  // observe the round trip without reading cross-origin frame DOM.
  const height = body.startsWith("viewer:") && body !== "viewer:guest" ? 121 : 80;
  bridge.port.postMessage({ type: "resize", token: bridge.token, height });
}

button.addEventListener("click", () => {
  void tip();
});
void tip();
