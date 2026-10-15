(() => {
  "use strict";

  const CLIENT_NAME = "MoviesWeb";
  const CLIENT_VERSION = "1.0.0";

  const store = {
    get token() { return localStorage.getItem("mw_token") || ""; },
    set token(v) { v ? localStorage.setItem("mw_token", v) : localStorage.removeItem("mw_token"); },
    get userId() { return localStorage.getItem("mw_user_id") || ""; },
    set userId(v) { v ? localStorage.setItem("mw_user_id", v) : localStorage.removeItem("mw_user_id"); },
    get deviceId() {
      let id = localStorage.getItem("mw_device_id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("mw_device_id", id);
      }
      return id;
    },
  };

  function authHeader(withToken) {
    let h = `MediaBrowser Client="${CLIENT_NAME}", Device="Browser", DeviceId="${store.deviceId}", Version="${CLIENT_VERSION}"`;
    if (withToken && store.token) h += `, Token="${store.token}"`;
    return h;
  }

  async function api(path, opts = {}) {
    const headers = Object.assign(
      { "Content-Type": "application/json", Authorization: authHeader(true) },
      opts.headers || {}
    );
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      logout();
      throw new Error("Session expired");
    }
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return null;
  }

  function apiKeyUrl(path, extraParams) {
    const params = new URLSearchParams(extraParams || {});
    params.set("ApiKey", store.token);
    return `${path}?${params.toString()}`;
  }

  function logout() {
    store.token = "";
    store.userId = "";
    view = "login";
    crumbs = [];
    items = [];
    continueWatching = [];
    render();
  }

  // ---- App state ----
  let view = "login";     // login | browse | player
  let crumbs = [];         // [{id, name}]
  let items = [];
  let continueWatching = [];
  let loading = false;
  let errorMsg = "";
  let playerItem = null;
  let loadGeneration = 0;

  const root = document.getElementById("app");

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ---- Views ----
  function renderLogin() {
    root.innerHTML = "";
    const userInput = el("input", { type: "text", placeholder: "Username", autocomplete: "username" });
    const passInput = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
    const err = el("div", { class: "error", style: "display:none;padding:0;" });

    async function doLogin(ev) {
      ev.preventDefault();
      err.style.display = "none";
      try {
        const res = await fetch("/Users/AuthenticateByName", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader(false) },
          body: JSON.stringify({ Username: userInput.value, Pw: passInput.value }),
        });
        if (!res.ok) throw new Error("Invalid username or password");
        const data = await res.json();
        store.token = data.AccessToken;
        store.userId = data.User.Id;
        view = "browse";
        crumbs = [];
        await loadRoot();
      } catch (e) {
        err.textContent = e.message || "Login failed";
        err.style.display = "block";
      }
    }

    const form = el("form", { class: "login-card", onsubmit: doLogin }, [
      userInput,
      passInput,
      err,
      el("button", { type: "submit", class: "btn" }, "Sign in"),
    ]);

    const brand = el("div", { class: "brand-mark" }, [
      el("div", { class: "wordmark" }, ["xenbyte", el("span", {}, ".movies")]),
      el("div", { class: "rule" }),
      el("div", { class: "tagline" }, "private cinema"),
    ]);

    root.appendChild(el("div", { class: "login-wrap" }, [brand, form]));
    setTimeout(() => userInput.focus(), 0);
  }

  async function loadRoot() {
    const gen = ++loadGeneration;
    loading = true; errorMsg = "";
    render();
    try {
      const views = await api(`/Users/${store.userId}/Views`);
      if (gen !== loadGeneration) return;
      const libs = (views.Items || []).filter((v) => v.Type === "CollectionFolder");
      if (libs.length === 1) {
        crumbs = [{ id: libs[0].Id, name: libs[0].Name }];
        await loadItems(libs[0].Id);
        return;
      }
      crumbs = [];
      items = libs;
      loading = false;
      render();
      loadContinueWatching();
    } catch (e) {
      if (gen !== loadGeneration) return;
      loading = false;
      errorMsg = e.message;
      render();
    }
  }

  async function loadItems(parentId) {
    const gen = ++loadGeneration;
    loading = true; errorMsg = "";
    render();
    try {
      const data = await api(
        `/Users/${store.userId}/Items?ParentId=${encodeURIComponent(parentId)}` +
          `&Recursive=false&SortBy=IsFolder,SortName&SortOrder=Descending,Ascending` +
          `&Fields=PrimaryImageAspectRatio`
      );
      if (gen !== loadGeneration) return;
      items = data.Items || [];
      loading = false;
      render();
      if (crumbs.length <= 1) loadContinueWatching();
    } catch (e) {
      if (gen !== loadGeneration) return;
      loading = false;
      errorMsg = e.message;
      render();
    }
  }

  async function loadContinueWatching() {
    try {
      const data = await api(
        `/Users/${store.userId}/Items/Resume?Limit=12&IncludeItemTypes=Movie,Episode,Video&MediaTypes=Video`
      );
      continueWatching = data.Items || [];
    } catch (e) {
      continueWatching = [];
    }
    if (view === "browse") render();
  }

  async function waitForLibraryIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tasks = await api("/ScheduledTasks?IsHidden=false");
        const task = tasks.find((t) => t.Key === "RefreshLibrary");
        if (!task || task.State === "Idle") return;
      } catch (e) { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function refreshLibrary(btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Refreshing…";
    try {
      await fetch("/Library/Refresh", { method: "POST", headers: { Authorization: authHeader(true) } });
      await new Promise((r) => setTimeout(r, 800));
      await waitForLibraryIdle(60000);
      const parentId = crumbs.length ? crumbs[crumbs.length - 1].id : null;
      if (parentId) await loadItems(parentId);
      else await loadRoot();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function findNextVideo(list, current) {
    const idx = list.findIndex((it) => it.Id === current.Id);
    if (idx === -1) return null;
    for (let i = idx + 1; i < list.length; i++) {
      if (!list[i].IsFolder) return list[i];
    }
    return null;
  }

  function thumbUrl(item) {
    if (item.ImageTags && item.ImageTags.Primary) {
      return apiKeyUrl(`/Items/${item.Id}/Images/Primary`, { maxWidth: 300, tag: item.ImageTags.Primary });
    }
    return "";
  }

  function renderBrowse() {
    root.innerHTML = "";
    const bc = el("div", { class: "breadcrumbs" }, [
      el("button", { onclick: () => { crumbs = []; loadRoot(); } }, "Home"),
    ]);
    crumbs.forEach((c, i) => {
      bc.appendChild(el("span", { class: "sep" }, "/"));
      const isLast = i === crumbs.length - 1;
      bc.appendChild(
        el(
          "button",
          {
            class: isLast ? "current" : "",
            onclick: () => {
              crumbs = crumbs.slice(0, i + 1);
              loadItems(c.id);
            },
          },
          c.name
        )
      );
    });

    const refreshBtn = el("button", { class: "btn", title: "Rescan library for changes" }, "Refresh");
    refreshBtn.addEventListener("click", () => refreshLibrary(refreshBtn));

    const topbar = el("div", { class: "topbar" }, [
      el("div", { class: "brand" }, ["xenbyte", el("span", { class: "sub" }, "movies")]),
      bc,
      refreshBtn,
      el("button", { class: "btn", onclick: logout }, "Sign out"),
    ]);

    const main = el("main");

    if (crumbs.length <= 1 && continueWatching.length > 0) {
      const cwGrid = el("div", { class: "grid cw-grid" });
      for (const cw of continueWatching) {
        const thumb = thumbUrl(cw);
        const thumbEl = el("div", {
          class: "thumb",
          style: thumb ? `background-image:url('${thumb}')` : "",
        });
        if (!thumb) thumbEl.textContent = "\u{1F3AC}";
        const runTicks = cw.RunTimeTicks || 0;
        const posTicks = (cw.UserData && cw.UserData.PlaybackPositionTicks) || 0;
        const pct = runTicks ? Math.min(100, (posTicks / runTicks) * 100) : 0;
        thumbEl.appendChild(
          el("div", { class: "cw-progress" }, [el("div", { class: "cw-progress-fill", style: `width:${pct}%` })])
        );
        const label = cw.SeriesName ? `${cw.SeriesName} — ${cw.Name}` : cw.Name;
        const tile = el(
          "div",
          { class: "tile video", tabindex: "0", role: "button" },
          [thumbEl, el("div", { class: "label" }, label)]
        );
        const activate = () => openPlayer(cw);
        tile.addEventListener("click", activate);
        tile.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
        });
        cwGrid.appendChild(tile);
      }
      main.appendChild(el("div", { class: "section-label" }, "Continue Watching"));
      main.appendChild(cwGrid);
    }

    if (loading) {
      main.appendChild(el("div", { class: "loading" }, "Loading..."));
    } else if (errorMsg) {
      main.appendChild(el("div", { class: "error" }, errorMsg));
    } else if (items.length === 0) {
      main.appendChild(el("div", { class: "empty" }, "Nothing here."));
    } else {
      const grid = el("div", { class: "grid" });
      for (const item of items) {
        const isFolder = !!item.IsFolder;
        const thumb = thumbUrl(item);
        const thumbEl = el("div", {
          class: "thumb",
          style: thumb ? `background-image:url('${thumb}')` : "",
        });
        if (!thumb) thumbEl.textContent = isFolder ? "\u{1F4C1}" : "\u{1F3AC}";
        const tile = el(
          "div",
          { class: `tile ${isFolder ? "folder" : "video"}`, tabindex: "0", role: "button" },
          [thumbEl, el("div", { class: "label" }, item.Name)]
        );
        const activate = () => {
          if (isFolder) {
            crumbs = crumbs.concat([{ id: item.Id, name: item.Name }]);
            loadItems(item.Id);
          } else {
            openPlayer(item, items);
          }
        };
        tile.addEventListener("click", activate);
        tile.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
        });
        grid.appendChild(tile);
      }
      main.appendChild(grid);
    }

    root.appendChild(topbar);
    root.appendChild(main);
  }

  // ---- Player ----
  const ICONS = {
    play: '<path d="M6 4l14 8-14 8z"/>',
    pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
    back10: '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H5a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
    fwd10: '<path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
    volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none"/><path d="M19 6a9 9 0 0 1 0 12" fill="none"/>',
    muted: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M19 9l-5 5M14 9l5 5" fill="none"/>',
    cc: '<rect x="2" y="5" width="20" height="14" rx="2" fill="none"/><path d="M9 10.5c-.5-.6-1.1-1-2-1-1.3 0-2.3 1.1-2.3 2.5S5.7 14.5 7 14.5c.9 0 1.5-.4 2-1M17.3 10.5c-.5-.6-1.1-1-2-1-1.3 0-2.3 1.1-2.3 2.5s1 2.5 2.3 2.5c.9 0 1.5-.4 2-1" fill="none"/>',
    audio: '<path d="M9 18V5l12-2v13" fill="none"/><circle cx="6" cy="18" r="3" fill="none"/><circle cx="18" cy="16" r="3" fill="none"/>',
    speed: '<circle cx="12" cy="13" r="8" fill="none"/><path d="M12 13l4-4M12 5V3M4.2 7.2l1.4 1.4M19.8 7.2l-1.4 1.4" fill="none"/>',
    pip: '<rect x="3" y="4" width="18" height="16" rx="1.5" fill="none"/><rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
    fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" fill="none"/>',
    fullscreenExit: '<path d="M9 3v3a2 2 0 0 1-2 2H4M15 3v3a2 2 0 0 0 2 2h3M9 21v-3a2 2 0 0 0-2-2H4M15 21v-3a2 2 0 0 1 2-2h3" fill="none"/>',
  };

  function icon(name, cls) {
    const span = document.createElement("span");
    span.className = `icon ${cls || ""}`;
    span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="currentColor">${ICONS[name]}</svg>`;
    return span;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  const player = {
    item: null,
    mediaSourceId: null,
    audioStreams: [],
    subtitleStreams: [],
    currentAudioIndex: null,
    currentSubtitleIndex: -1,
    playSessionId: null,
    initialResumeSeconds: 0,
    progressTimer: null,
    nextItem: null,
    siblingList: null,
    upNextTimer: null,
    hls: null,
    video: null,
    wrap: null,
    hideTimer: null,
    keydownHandler: null,
    docClickHandler: null,
    openMenu: null,
  };

  function stopEncoding(playSessionId) {
    if (!playSessionId) return Promise.resolve();
    return fetch(apiKeyUrl("/Videos/ActiveEncodings", { DeviceId: store.deviceId, PlaySessionId: playSessionId }), {
      method: "DELETE",
    }).catch(() => {});
  }

  function reportPlayingStart() {
    if (!player.item) return;
    fetch(apiKeyUrl("/Sessions/Playing"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ItemId: player.item.Id,
        MediaSourceId: player.mediaSourceId,
        PlaySessionId: player.playSessionId,
        PositionTicks: Math.round((player.video.currentTime || 0) * 10000000),
        CanSeek: true,
        PlayMethod: "Transcode",
      }),
    }).catch(() => {});
  }

  function reportProgress(isPaused) {
    if (!player.item || !player.video) return;
    fetch(apiKeyUrl("/Sessions/Playing/Progress"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ItemId: player.item.Id,
        MediaSourceId: player.mediaSourceId,
        PlaySessionId: player.playSessionId,
        PositionTicks: Math.round((player.video.currentTime || 0) * 10000000),
        IsPaused: !!isPaused,
        PlayMethod: "Transcode",
      }),
    }).catch(() => {});
  }

  function reportStopped() {
    if (!player.item || !player.video || !player.playSessionId) return;
    const payload = JSON.stringify({
      ItemId: player.item.Id,
      MediaSourceId: player.mediaSourceId,
      PlaySessionId: player.playSessionId,
      PositionTicks: Math.round((player.video.currentTime || 0) * 10000000),
    });
    const url = apiKeyUrl("/Sessions/Playing/Stopped");
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    } else {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
    }
  }

  async function openPlayer(item, siblingList) {
    try {
      const detail = await api(`/Users/${store.userId}/Items/${item.Id}`);
      playerItem = detail;
      const posTicks = (detail.UserData && detail.UserData.PlaybackPositionTicks) || 0;
      player.initialResumeSeconds = posTicks / 10000000;
      player.siblingList = siblingList || null;
      player.nextItem = siblingList ? findNextVideo(siblingList, item) : null;
      view = "player";
      render();
    } catch (e) {
      errorMsg = e.message;
      render();
    }
  }

  function teardownPlayerSession() {
    reportStopped();
    stopEncoding(player.playSessionId);
    if (player.progressTimer) clearInterval(player.progressTimer);
    if (player.upNextTimer) clearInterval(player.upNextTimer);
    if (player.hls) { player.hls.destroy(); player.hls = null; }
    if (player.keydownHandler) document.removeEventListener("keydown", player.keydownHandler);
    if (player.docClickHandler) document.removeEventListener("click", player.docClickHandler);
    if (player.beforeUnloadHandler) window.removeEventListener("beforeunload", player.beforeUnloadHandler);
    if (player.hideTimer) clearTimeout(player.hideTimer);
    Object.assign(player, {
      item: null, video: null, wrap: null, hideTimer: null, progressTimer: null, upNextTimer: null,
      keydownHandler: null, docClickHandler: null, beforeUnloadHandler: null, openMenu: null, playSessionId: null,
      nextItem: null, siblingList: null,
    });
  }

  function closePlayer() {
    teardownPlayerSession();
    playerItem = null;
    view = "browse";
    if (crumbs.length <= 1) loadContinueWatching();
    render();
  }

  function advanceToNext() {
    if (!player.nextItem) return;
    const next = player.nextItem;
    const siblingList = player.siblingList;
    teardownPlayerSession();
    openPlayer(next, siblingList);
  }

  function showUpNext() {
    if (!player.nextItem || !player.wrap) return;
    const next = player.nextItem;
    const thumb = thumbUrl(next);
    let remaining = 10;

    const thumbEl = el("div", {
      class: "upnext-thumb",
      style: thumb ? `background-image:url('${thumb}')` : "",
    });
    if (!thumb) thumbEl.textContent = "\u{1F3AC}";

    const playBtnLabel = el("span", {}, `Play now (${remaining}s)`);
    const dismiss = () => { if (player.upNextTimer) clearInterval(player.upNextTimer); player.upNextTimer = null; box.remove(); };

    const box = el("div", { class: "player-upnext" }, [
      thumbEl,
      el("div", { class: "upnext-info" }, [
        el("div", { class: "upnext-label" }, "Up Next"),
        el("div", { class: "upnext-title" }, next.Name),
        el("div", { class: "upnext-actions" }, [
          el("button", { class: "btn", onclick: dismiss }, "Cancel"),
          el("button", { class: "btn upnext-play", onclick: () => { dismiss(); advanceToNext(); } }, [playBtnLabel]),
        ]),
      ]),
    ]);
    player.wrap.appendChild(box);

    player.upNextTimer = setInterval(() => {
      remaining -= 1;
      playBtnLabel.textContent = `Play now (${remaining}s)`;
      if (remaining <= 0) {
        clearInterval(player.upNextTimer);
        player.upNextTimer = null;
        box.remove();
        advanceToNext();
      }
    }, 1000);
  }

  function buildStreamUrl() {
    const params = {
      MediaSourceId: player.mediaSourceId,
      VideoCodec: "h264",
      AudioCodec: "aac,ac3,eac3,mp3,flac,opus",
      MaxAudioChannels: 6,
      DeviceId: store.deviceId,
      PlaySessionId: player.playSessionId,
    };
    if (player.currentAudioIndex != null) params.AudioStreamIndex = player.currentAudioIndex;
    return apiKeyUrl(`/Videos/${player.item.Id}/master.m3u8`, params);
  }

  function showFatalPlayerError(message) {
    setBuffering(false);
    if (player.hls) { player.hls.destroy(); player.hls = null; }
    if (!player.wrap) return;
    const existing = player.wrap.querySelector(".player-fatal-error");
    if (existing) existing.remove();
    const box = el("div", { class: "player-fatal-error" }, [
      el("div", { class: "player-fatal-error-msg" }, message),
      el(
        "button",
        {
          class: "btn",
          onclick: () => { box.remove(); attachSource(player.video.currentTime || 0, true); },
        },
        "Retry"
      ),
    ]);
    player.wrap.appendChild(box);
  }

  function attachSource(resumeTime, wasPlaying) {
    const video = player.video;
    if (player.hls) { player.hls.destroy(); player.hls = null; }
    if (player.wrap) {
      const existingErr = player.wrap.querySelector(".player-fatal-error");
      if (existingErr) existingErr.remove();
    }
    player.networkErrorCount = 0;
    player.mediaErrorCount = 0;
    const url = buildStreamUrl();

    const onReady = () => {
      if (resumeTime) video.currentTime = resumeTime;
      if (wasPlaying) video.play().catch(() => {});
      reportPlayingStart();
      if (player.progressTimer) clearInterval(player.progressTimer);
      player.progressTimer = setInterval(() => {
        if (player.video && !player.video.paused) reportProgress(false);
      }, 10000);
    };

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ maxBufferLength: 30 });
      player.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.once(window.Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          player.networkErrorCount++;
          if (player.networkErrorCount > 3) showFatalPlayerError("Lost connection to the server.");
          else hls.startLoad();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          player.mediaErrorCount++;
          if (player.mediaErrorCount > 2) showFatalPlayerError("This video could not be played.");
          else hls.recoverMediaError();
        } else {
          showFatalPlayerError("Playback error. Please try again.");
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", () => showFatalPlayerError("This video could not be played."), { once: true });
    }
  }

  function switchAudio(index) {
    if (index === player.currentAudioIndex) return;
    const t = player.video.currentTime;
    const wasPlaying = !player.video.paused;
    const oldSession = player.playSessionId;
    player.currentAudioIndex = index;
    player.playSessionId = crypto.randomUUID();
    setBuffering(true);
    stopEncoding(oldSession).finally(() => attachSource(t, wasPlaying));
  }

  function setBuffering(on) {
    if (player.wrap) player.wrap.classList.toggle("buffering", on);
  }

  function switchSubtitle(index) {
    player.currentSubtitleIndex = index;
    const tracks = player.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = player.subtitleStreams[i].Index === index ? "showing" : "disabled";
    }
  }

  function closeMenus() {
    if (player.openMenu) { player.openMenu.remove(); player.openMenu = null; }
  }

  function toggleMenu(anchorBtn, options, selected, onSelect) {
    if (player.openMenu) {
      const wasForThisBtn = player.openMenu.dataset.forBtn === anchorBtn.dataset.id;
      closeMenus();
      if (wasForThisBtn) return;
    }
    const menu = el("div", { class: "menu" });
    menu.dataset.forBtn = anchorBtn.dataset.id;
    options.forEach((opt) => {
      const item = el(
        "button",
        {
          class: `menu-item ${opt.value === selected ? "active" : ""}`,
          onclick: (e) => { e.stopPropagation(); closeMenus(); onSelect(opt.value); },
        },
        opt.label
      );
      menu.appendChild(item);
    });
    anchorBtn.parentElement.appendChild(menu);
    player.openMenu = menu;
  }

  function showControls() {
    if (!player.wrap) return;
    player.wrap.classList.remove("controls-hidden");
    if (player.hideTimer) clearTimeout(player.hideTimer);
    player.hideTimer = setTimeout(() => {
      if (player.video && !player.video.paused && !player.openMenu) {
        player.wrap.classList.add("controls-hidden");
      }
    }, 3000);
  }

  function renderPlayer() {
    root.innerHTML = "";
    const item = playerItem;
    const source = (item.MediaSources || [])[0] || {};
    player.item = item;
    player.mediaSourceId = source.Id || item.Id;
    const streams = source.MediaStreams || [];
    player.audioStreams = streams.filter((s) => s.Type === "Audio");
    player.subtitleStreams = streams.filter((s) => s.Type === "Subtitle");

    const japaneseAudio = player.audioStreams.find((s) => {
      const l = (s.Language || "").toLowerCase();
      return l === "jpn" || l === "ja" || l.startsWith("jp");
    });
    const defaultAudio = japaneseAudio || player.audioStreams.find((s) => s.IsDefault) || player.audioStreams[0];
    player.currentAudioIndex = defaultAudio ? defaultAudio.Index : null;
    const englishSub = player.subtitleStreams.find((s) => (s.Language || "").toLowerCase().startsWith("en"));
    const defaultSub = englishSub || player.subtitleStreams[0];
    player.currentSubtitleIndex = defaultSub ? defaultSub.Index : -1;
    player.playSessionId = crypto.randomUUID();

    const video = el("video", { playsinline: "", autoplay: "" });
    player.video = video;

    for (const s of player.subtitleStreams) {
      video.appendChild(
        el("track", {
          kind: "subtitles",
          label: s.DisplayTitle || s.Language || `Track ${s.Index}`,
          srclang: s.Language || "und",
          src: apiKeyUrl(`/Videos/${item.Id}/${player.mediaSourceId}/Subtitles/${s.Index}/Stream.vtt`),
        })
      );
    }

    const topbar = el("div", { class: "player-topbar" }, [
      el("button", { class: "btn", onclick: closePlayer }, "← Back"),
      el("div", { class: "player-title" }, item.Name),
    ]);

    const centerPlay = el("button", { class: "center-play", onclick: () => video.play() }, icon("play"));
    const spinner = el("div", { class: "spinner" });

    // -- progress bar --
    const progressPlayed = el("div", { class: "progress-played" });
    const progressBuffered = el("div", { class: "progress-buffered" });
    const progressHandle = el("div", { class: "progress-handle" });
    const progress = el("div", { class: "progress" }, [progressBuffered, progressPlayed, progressHandle]);

    function seekFromEvent(clientX) {
      const rect = progress.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (video.duration) video.currentTime = ratio * video.duration;
    }
    let scrubbing = false;
    progress.addEventListener("mousedown", (e) => {
      scrubbing = true;
      seekFromEvent(e.clientX);
      const onMove = (ev) => seekFromEvent(ev.clientX);
      const onUp = () => {
        scrubbing = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    const timeText = el("div", { class: "time-text" }, "0:00 / 0:00");

    // -- buttons --
    const playBtn = el("button", { class: "icon-btn", "data-id": "play" }, icon("play"));
    playBtn.addEventListener("click", () => (video.paused ? video.play() : video.pause()));

    const back10 = el("button", { class: "icon-btn", "data-id": "back10", title: "Back 10s" }, icon("back10"));
    back10.addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 10); });

    const fwd10 = el("button", { class: "icon-btn", "data-id": "fwd10", title: "Forward 10s" }, icon("fwd10"));
    fwd10.addEventListener("click", () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); });

    const volumeBtn = el("button", { class: "icon-btn", "data-id": "volume", title: "Mute" }, icon("volume"));
    const volumeSlider = el("input", { type: "range", min: "0", max: "100", value: "100", class: "volume-slider" });
    volumeBtn.addEventListener("click", () => {
      video.muted = !video.muted;
    });
    volumeSlider.addEventListener("input", () => {
      video.volume = Number(volumeSlider.value) / 100;
      video.muted = video.volume === 0;
    });

    const audioBtn = el("button", { class: "icon-btn", "data-id": "audio", title: "Audio track" }, icon("audio"));
    audioBtn.style.display = player.audioStreams.length > 1 ? "" : "none";
    audioBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(
        audioBtn,
        player.audioStreams.map((s) => ({ value: s.Index, label: s.DisplayTitle || s.Language || `Track ${s.Index}` })),
        player.currentAudioIndex,
        switchAudio
      );
    });

    const subsBtn = el("button", { class: "icon-btn", "data-id": "subs", title: "Subtitles" }, icon("cc"));
    subsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opts = [{ value: -1, label: "Off" }].concat(
        player.subtitleStreams.map((s) => ({ value: s.Index, label: s.DisplayTitle || s.Language || `Track ${s.Index}` }))
      );
      toggleMenu(subsBtn, opts, player.currentSubtitleIndex, switchSubtitle);
    });

    const speedBtn = el("button", { class: "icon-btn", "data-id": "speed", title: "Playback speed" }, icon("speed"));
    let currentSpeed = 1;
    speedBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
      toggleMenu(
        speedBtn,
        speeds.map((v) => ({ value: v, label: `${v}×` })),
        currentSpeed,
        (v) => { currentSpeed = v; video.playbackRate = v; }
      );
    });

    const pipBtn = el("button", { class: "icon-btn", "data-id": "pip", title: "Picture in picture" }, icon("pip"));
    if (!document.pictureInPictureEnabled) pipBtn.style.display = "none";
    pipBtn.addEventListener("click", () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else video.requestPictureInPicture().catch(() => {});
    });

    const fullscreenBtn = el("button", { class: "icon-btn", "data-id": "fullscreen" }, icon("fullscreen"));
    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else wrap.requestFullscreen().catch(() => {});
    });

    const controlsBar = el("div", { class: "controls-bar" }, [
      progress,
      el("div", { class: "controls-row" }, [
        el("div", { class: "controls-group" }, [
          playBtn, back10, fwd10,
          el("div", { class: "volume-group" }, [volumeBtn, volumeSlider]),
          timeText,
        ]),
        el("div", { class: "controls-group" }, [audioBtn, subsBtn, speedBtn, pipBtn, fullscreenBtn]),
      ]),
    ]);

    const wrap = el("div", { class: "player-wrap paused" }, [topbar, video, centerPlay, spinner, controlsBar]);
    player.wrap = wrap;
    root.appendChild(wrap);

    // -- wire up video events --
    video.addEventListener("play", () => { wrap.classList.remove("paused"); playBtn.replaceChildren(icon("pause")); showControls(); });
    video.addEventListener("pause", () => { wrap.classList.add("paused"); playBtn.replaceChildren(icon("play")); wrap.classList.remove("controls-hidden"); reportProgress(true); });
    video.addEventListener("waiting", () => wrap.classList.add("buffering"));
    video.addEventListener("playing", () => wrap.classList.remove("buffering"));
    video.addEventListener("ended", () => { if (player.nextItem) showUpNext(); });
    video.addEventListener("volumechange", () => {
      volumeBtn.replaceChildren(icon(video.muted || video.volume === 0 ? "muted" : "volume"));
    });
    video.addEventListener("timeupdate", () => {
      if (!video.duration) return;
      const ratio = video.currentTime / video.duration;
      if (!scrubbing) {
        progressPlayed.style.width = `${ratio * 100}%`;
        progressHandle.style.left = `${ratio * 100}%`;
      }
      timeText.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    });
    video.addEventListener("progress", () => {
      if (video.buffered.length && video.duration) {
        const end = video.buffered.end(video.buffered.length - 1);
        progressBuffered.style.width = `${(end / video.duration) * 100}%`;
      }
    });
    video.addEventListener("loadedmetadata", () => {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = player.subtitleStreams[i].Index === player.currentSubtitleIndex ? "showing" : "disabled";
      }
    });

    document.addEventListener("fullscreenchange", () => {
      fullscreenBtn.replaceChildren(icon(document.fullscreenElement ? "fullscreenExit" : "fullscreen"));
    });

    wrap.addEventListener("mousemove", showControls);
    wrap.addEventListener("click", (e) => {
      if (e.target === video) (video.paused ? video.play() : video.pause());
    });
    showControls();

    player.docClickHandler = () => closeMenus();
    document.addEventListener("click", player.docClickHandler);

    player.keydownHandler = (e) => {
      if (e.code === "Space" || e.key === "k") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      else if (e.key === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 10);
      else if (e.key === "ArrowRight") video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      else if (e.key === "ArrowUp") { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); volumeSlider.value = video.volume * 100; }
      else if (e.key === "ArrowDown") { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); volumeSlider.value = video.volume * 100; }
      else if (e.key === "m") video.muted = !video.muted;
      else if (e.key === "f") fullscreenBtn.click();
      else if (e.key === "Escape" && document.fullscreenElement) document.exitFullscreen();
    };
    document.addEventListener("keydown", player.keydownHandler);

    player.beforeUnloadHandler = () => reportStopped();
    window.addEventListener("beforeunload", player.beforeUnloadHandler);

    if (window.Hls && window.Hls.isSupported()) {
      attachSource(player.initialResumeSeconds, true);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      attachSource(player.initialResumeSeconds, true);
    } else {
      wrap.appendChild(el("div", { class: "error" }, "This browser cannot play HLS streams."));
    }
  }

  function render() {
    if (view === "login") return renderLogin();
    if (view === "player") return renderPlayer();
    return renderBrowse();
  }

  // ---- Boot ----
  (async function init() {
    if (store.token && store.userId) {
      view = "browse";
      try {
        await loadRoot();
      } catch (e) {
        logout();
      }
    } else {
      render();
    }
  })();
})();
