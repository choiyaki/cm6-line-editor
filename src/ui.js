import { auth, provider } from "../firebase.js";
import { signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { EditorView } from "https://esm.sh/@codemirror/view";
import { saveTitleLocal, loadTitleLocal } from "./firebase-sync.js";

export let titleInput = null;
export let headerEl = null;

let loginBtn = null;
let logoutBtn = null;
let menuBtn = null;
let menuPanel = null;
let editorFocused = false;
let keyboardVisible = false;

export function initUI(view) {
  // DOM取得
  headerEl   = document.getElementById("app-header");
  titleInput = document.querySelector(".header-title");
  loginBtn  = document.getElementById("login-btn");
  logoutBtn = document.getElementById("logout-btn");
  menuBtn   = document.getElementById("menu-btn");
  menuPanel = document.getElementById("menu-panel");

  // --- title ---
  if (titleInput) {
    titleInput.value = loadTitleLocal();

    // 変更したら保存イベント（※必要に応じて sync側へ通知するかどうか）
    // 現状はfirebase-sync.jsで定義した saveTitle を呼びたいが、相互依存を防ぐため
    // EventListenerはこのファイルで設定しつつ、ロジック自体は firebase-sync を呼ぶ構成に。
    import("./firebase-sync.js").then(({ saveTitle }) => {
      titleInput.addEventListener("input", saveTitle);
      titleInput.addEventListener("blur", saveTitle);
    });
  }

  // --- login ---
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        console.error("[login] failed", e);
      }
    });
  }

  // --- logout ---
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await signOut(auth);
      if (menuPanel) menuPanel.hidden = true;
    });
  }

  // --- menu ---
  if (menuBtn && menuPanel) {
    menuBtn.addEventListener("click", e => {
      e.stopPropagation();
      menuPanel.hidden = !menuPanel.hidden;
    });

    document.addEventListener("click", () => {
      menuPanel.hidden = true;
    });
  }

  // キーボード検知（iOS / Android 共通で安定）
  if (window.visualViewport) {
    const baseHeight = window.visualViewport.height;

    visualViewport.addEventListener("resize", () => {
      const diff = baseHeight - visualViewport.height;
      // ソフトウェアキーボード判定
      keyboardVisible = diff > 120;
      updateHeaderVisibility();
    });
  }
}

// 表示制御
export function updateHeaderVisibility() {
  if (!headerEl) return;
  if (editorFocused && keyboardVisible) {
    headerEl.classList.add("is-hidden");
    document.body.classList.add("header-hidden");
  } else {
    headerEl.classList.remove("is-hidden");
    document.body.classList.remove("header-hidden");
  }
}

// ヘッダー隠蔽のためのフォーカス監視プラグイン
export const headerFocusWatcher = EditorView.domEventHandlers({
  focus() {
    editorFocused = true;
    updateHeaderVisibility();
  },
  blur() {
    editorFocused = false;
    updateHeaderVisibility();
  }
});

// エクスポートボタン（Shortcutsへの連携用）
export function exportDocument(view) {
  if (!view) return;

  const title = localStorage.getItem("cm6-doc-title")?.trim() || "無題";

  import("./cm-plugins/export-utils.js").then(({ buildExportText }) => {
    // ブロック除外済み本文
    const filteredBody = buildExportText(view.state.doc)
      .replace(/  /g, " ")
      .replace(/\- /g, " ");

    const bodyText = title + "\n" + filteredBody;

    if (!filteredBody.trim()) {
      alert("本文が空です");
      return;
    }

    const url =
      `shortcuts://run-shortcut?name=Choiyakiをmd保存&input=${encodeURIComponent(bodyText)}`;

    window.location.href = url;
  });
}
