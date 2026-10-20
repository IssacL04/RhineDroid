if (new URLSearchParams(location.search).get("renderer") === "vulkan")
  document.documentElement.dataset.renderer = "vulkan";
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });
document.addEventListener("dragstart", (event) => {
  if (event.target instanceof Element && event.target.closest("img, canvas")) event.preventDefault();
}, { capture: true });
void import("./music-app").catch(() => {
  const stage = document.querySelector<HTMLElement>("#stage")!;
  stage.style.cssText = "position:fixed;inset:0;width:100%;height:100%;transform:none;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#e8e5e1;color:#232722;font-family:sans-serif;text-align:center;padding:24px";
  const title = document.createElement("h2");
  title.textContent = "界面未能打开";
  const message = document.createElement("p");
  message.textContent = "请更新 Android System WebView 后重试。也可以使用系统返回退出。";
  const retry = document.createElement("button");
  retry.textContent = "重新打开";
  retry.style.cssText = "min-height:48px;padding:12px 24px";
  retry.addEventListener("click", () => location.reload());
  stage.innerHTML = "";
  stage.appendChild(title);
  stage.appendChild(message);
  stage.appendChild(retry);
});
