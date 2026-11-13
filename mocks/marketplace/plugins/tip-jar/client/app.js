// Sandboxed tip-jar client app. It talks only through the per-iframe MessageChannel.
const button = document.getElementById("tip");
const result = document.getElementById("result");

new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "bulletin:bridge:init") {
      return;
    }

    const port = event.ports[0];
    if (port === undefined || typeof event.data.token !== "string") {
      return;
    }

    port.start();
    port.postMessage({ type: "resize", token: event.data.token, height: 80 });
    resolve({ port, token: event.data.token });
  });
}).then((bridge) => {
  button.addEventListener("click", () => {
    bridge.port.postMessage({
      type: "toast",
      token: bridge.token,
      messageKey: "plugin.tips.thanks",
    });
    result.textContent = "✓";
  });
});
