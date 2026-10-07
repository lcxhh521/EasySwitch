// Appearance preference only. No account settings, network requests or credentials.
(function (root) {
  "use strict";
  const choices = ["system", "light", "dark"], key = "easyswitch.theme";
  let mode = "system", storageAvailable = true;
  const note = () => storageAvailable ? "默认跟随系统，也可以固定为浅色或深色。" : "浏览器未允许保存外观偏好；当前选择仅对本页面生效。";
  try { const stored = root.localStorage?.getItem(key); if (choices.includes(stored)) mode = stored; } catch { storageAvailable = false; }
  const apply = () => {
    const html = root.document?.documentElement;
    if (html) { if (mode === "system") html.removeAttribute("data-theme"); else html.setAttribute("data-theme", mode); }
    for (const element of root.document?.querySelectorAll?.("[data-theme-note]") ?? []) element.textContent = note();
    for (const button of root.document?.querySelectorAll?.("[data-theme-choice]") ?? []) button.setAttribute("aria-pressed", String(button.dataset.themeChoice === mode));
  };
  const set = value => {
    if (!choices.includes(value)) return false;
    mode = value;
    try { root.localStorage?.setItem(key, mode); } catch { storageAvailable = false; }
    apply(); return true;
  };
  const controls = () => `<section class="card appearance-card" aria-labelledby="appearance-title"><div><h2 id="appearance-title">外观</h2><p class="hint" data-theme-note>${note()}</p></div><div class="seg theme-choice" role="group" aria-label="颜色主题">${[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([value, label]) => `<button type="button" data-theme-choice="${value}" aria-pressed="${mode === value}">${label}</button>`).join("")}</div></section>`;
  root.EasySwitchTheme = Object.freeze({ get: () => mode, set, controls, apply });
  apply();
})(globalThis);
