import { db, auth } from "../firebase.js";
import { EditorState } from "https://esm.sh/@codemirror/state";
import { EditorView } from "https://esm.sh/@codemirror/view";
import { doc, setDoc, onSnapshot, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { titleInput } from "./ui.js";

// ====== 定数と状態変数 ======
const LOCAL_TEXT_KEY = "cm6-doc-text";
export const LOCAL_TITLE_KEY = "cm6-doc-title";

export let currentDocPath = null;
export let currentUser = null;
export let docRef = null;

export let networkState = "ONLINE";
export let syncMode = "OFFLINE";

export let isInitializing = true;
export let isApplyingRemote = false; // Firestore反映中フラグ
export let isComposing = false;      // IME入力中
export let isLocalEditing = false;
export let appendStart = null;
export let isRecovering = false;

let pendingAppendText = readAppendTextFromURL();
let appendApplied = false;
let unsubscribe = null;
let saveTimer = null;         // debounce用


// URLから初期パラメータを取得
function resolveCurrentDocPath() {
    const params = new URLSearchParams(location.search);
    const page = params.get("page") ?? "main";
    return { page };
}
const { page } = resolveCurrentDocPath();
currentDocPath = page;

// ユーザー用ドキュメント参照を取得
export function getUserDocRef(uid) {
    return doc(db, "users", uid, "memos", "main");
}

try {
    await setPersistence(auth, browserLocalPersistence);
} catch (e) {
    console.warn("setPersistence failed", e);
}

// ====== ローカルストレージ関連 ======

export function saveToLocal(state) {
    localStorage.setItem(LOCAL_TEXT_KEY, state.doc.toString());
}

export function loadFromLocal() {
    return localStorage.getItem(LOCAL_TEXT_KEY) ?? "";
}

export function saveTitleLocal(value) {
    localStorage.setItem(LOCAL_TITLE_KEY, value);
}

export function loadTitleLocal() {
    return localStorage.getItem(LOCAL_TITLE_KEY) ?? "";
}

export function getCurrentTitle() {
    const saved = localStorage.getItem(LOCAL_TITLE_KEY);
    if (saved && saved.trim() !== "") {
        return saved.trim();
    }
    return (saved && saved.trim() !== "") ? saved.trim() : "無題";
}

// URLからのテキスト受取用
function readAppendTextFromURL() {
    const params = new URLSearchParams(location.search);
    return params.get("text");
}

function onInitialFirestoreLoaded(editor) {
    if (!pendingAppendText || appendApplied) return;

    const docState = editor.state.doc;
    const content = docState.toString();
    let insertText = pendingAppendText;

    // 末尾が空行でなければ空行をあける
    if (!content.endsWith("\n\n")) {
        insertText = "\n\n" + pendingAppendText;
    }

    editor.dispatch({
        changes: {
            from: docState.length,
            insert: insertText
        }
    });

    appendApplied = true;
    pendingAppendText = null;
}

// ====== Sync ロジック ======

export function updateNetworkState(online) {
    networkState = online ? "ONLINE" : "OFFLINE";
    document.body.classList.toggle("is-offline", !online);
}

export function applyTitleFromRemote(title) {
    const normalized = title?.trim() || "無題";
    if (titleInput) {
        titleInput.value = normalized;
    }
    saveTitleLocal(normalized);
}

export function saveTitle() {
    const value = titleInput ? titleInput.value.trim() || "無題" : "無題";
    saveTitleLocal(value);

    if (!docRef || isInitializing) return;

    setDoc(docRef, {
        title: value,
        updatedAt: serverTimestamp()
    }, { merge: true });
}

export function scheduleSave(state) {
    if (isInitializing || isApplyingRemote || isComposing) return;

    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
        if (networkState === "OFFLINE" || !docRef) {
            saveToLocal(state);
            return;
        }

        setDoc(docRef, {
            title: getCurrentTitle(),
            text: state.doc.toString(),
            updatedAt: serverTimestamp()
        }, { merge: true });
    }, 500);
}

// ====== Firestore リアルタイム同期 ======

export function stopFirestoreSync() {
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
}

export async function startFirestoreSync(view, ref) {
    if (!view || !ref) return;

    stopFirestoreSync();
    isInitializing = true;
    syncMode = "ONLINE_LOADING";

    let snap;
    try {
        snap = await getDoc(ref);
    } catch (e) {
        syncMode = "OFFLINE";
        isInitializing = false;
        return;
    }

    if (!snap.exists()) {
        isInitializing = false;
        return;
    }

    const data = snap.data();
    const text = data.text ?? "";
    const title = data.title ?? "無題";

    isApplyingRemote = true;
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text }
    });
    isApplyingRemote = false;

    applyTitleFromRemote(title);
    localStorage.setItem(LOCAL_TEXT_KEY, text);
    saveTitleLocal(title);

    onInitialFirestoreLoaded(view);

    syncMode = "ONLINE_READY";
    isInitializing = false;

    unsubscribe = onSnapshot(ref, snap => {
        if (isRecovering) return;

        try {
            if (!snap.exists() || syncMode !== "ONLINE_READY" || isApplyingRemote || view?.hasFocus || isComposing || isLocalEditing) {
                return;
            }

            const data = snap.data();
            if (!data) return;

            const remoteText = data.text ?? "";
            const remoteTitle = data.title ?? "無題";

            const current = view.state.doc.toString();

            if (remoteText !== current) {
                isApplyingRemote = true;
                view.dispatch({
                    changes: { from: 0, to: current.length, insert: remoteText }
                });
                isApplyingRemote = false;
                localStorage.setItem(LOCAL_TEXT_KEY, remoteText);
            }

            const currentTitleVal = titleInput ? titleInput.value : loadTitleLocal();
            if (currentTitleVal !== remoteTitle) {
                applyTitleFromRemote(remoteTitle);
            }

        } catch (e) {
            console.error("[snapshot] handler crashed", e);
        }
    });
}

// ====== オフライン復旧関連 ======

export async function recoverFromOffline(view, ref) {
    if (isRecovering) return;
    isRecovering = true;

    let snap;
    try {
        snap = await getDoc(ref);
    } catch (e) {
        isRecovering = false;
        return;
    }

    if (!snap.exists()) {
        isRecovering = false;
        return;
    }

    const firestoreText = snap.data().text ?? "";
    const localText = loadFromLocal() ?? "";

    const appendText = localText.slice(appendStart);
    const finalText = firestoreText + appendText;

    await setDoc(ref, { text: finalText, updatedAt: serverTimestamp() }, { merge: true });

    isApplyingRemote = true;
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: finalText }
    });
    isApplyingRemote = false;

    localStorage.setItem(LOCAL_TEXT_KEY, finalText);

    appendStart = null;
    syncMode = "ONLINE_READY";
    isRecovering = false;
}

// ====== 外部から呼ばれるエディタ拡張 ======

export const syncExtension = EditorView.updateListener.of(update => {
    if (!update.docChanged) return;
    if (isInitializing || isApplyingRemote || isComposing) return;
    scheduleSave(update.state);
});

export const imeWatcher = EditorView.domEventHandlers({
    compositionstart() {
        isComposing = true;
    },
    compositionend(event, view) {
        isComposing = false;
        scheduleSave(view.state);
    }
});

export function appendOnlyFilter() {
    return EditorState.transactionFilter.of(tr => {
        if (!tr.docChanged || typeof appendStart !== "number") return tr;

        let invalid = false;
        tr.changes.iterChanges((fromA, toA) => {
            if (fromA < appendStart || toA < appendStart) invalid = true;
        });

        if (invalid) return [];
        return tr;
    });
}

export function initAuth(view) {
    onAuthStateChanged(auth, async user => {
        if (user) {
            currentUser = user;
            docRef = getUserDocRef(user.uid);

            let snap;
            try {
                snap = await getDoc(docRef);
            } catch (e) {
                return; // offline
            }

            if (!snap.exists()) {
                await setDoc(docRef, {
                    title: loadTitleLocal(),
                    text: loadFromLocal(),
                    createdAt: serverTimestamp()
                });
            }

            startFirestoreSync(view, docRef);
        } else {
            stopFirestoreSync();
            docRef = null;
        }
    });
}

export function setupNetworkListeners(editorView) {
    window.addEventListener("online", async () => {
        updateNetworkState(true);
        if (appendStart !== null) {
            await recoverFromOffline(editorView, docRef);
        }
        startFirestoreSync(editorView, docRef);
    });

    window.addEventListener("offline", () => {
        updateNetworkState(false);
        if (editorView && appendStart === null) {
            appendStart = editorView.state.doc.length;
        }
        if (editorView) {
            editorView.dispatch({
                changes: {
                    from: editorView.state.doc.length,
                    to: editorView.state.doc.length,
                    insert: "\n\n"
                }
            });
        }
    });

    if (!navigator.onLine) {
        const localText = loadFromLocal() ?? "";
        appendStart = localText.length;
        syncMode = "OFFLINE";
    }
}
