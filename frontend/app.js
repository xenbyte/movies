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
    render();
  }

  // ---- App state ----
  let view = "login";     // login | browse | player
  let crumbs = [];         // [{id, name}]
  let items = [];
  let loading = false;
  let errorMsg = "";
  let playerItem = null;

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
    loading = true; errorMsg = "";
    render();
    try {
      const views = await api(`/Users/${store.userId}/Views`);
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
    } catch (e) {
      loading = false;
      errorMsg = e.message;
      render();
    }
  }

  async function loadItems(parentId) {
    loading = true; errorMsg = "";
    render();
    try {
      const data = await api(
        `/Users/${store.userId}/Items?ParentId=${encodeURIComponent(parentId)}` +
          `&Recursive=false&SortBy=IsFolder,SortName&SortOrder=Descending,Ascending` +
          `&Fields=PrimaryImageAspectRatio`
      );
      items = data.Items || [];
      loading = false;
      render();
    } catch (e) {
      loading = false;
      errorMsg = e.message;
      render();
    }
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

    const topbar = el("div", { class: "topbar" }, [
      el("div", { class: "brand" }, ["xenbyte", el("span", { class: "sub" }, "movies")]),
      bc,
      el("button", { class: "btn", onclick: logout }, "Sign out"),
    ]);

    const main = el("main");

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
        const tile = el("div", { class: `tile ${isFolder ? "folder" : "video"}` }, [
          thumbEl,
          el("div", { class: "label" }, item.Name),
        ]);
        tile.addEventListener("click", () => {
          if (isFolder) {
            crumbs = crumbs.concat([{ id: item.Id, name: item.Name }]);
            loadItems(item.Id);
          } else {
            openPlayer(item);
          }
        });
        grid.appendChild(tile);
      }
      main.appendChild(grid);
    }

    root.appendChild(topbar);
    root.appendChild(main);
  }

  // ---- Player ----
  let hlsInstance = null;

  async function openPlayer(item) {
    try {
      const detail = await api(`/Users/${store.userId}/Items/${item.Id}`);
      playerItem = detail;
      view = "player";
      render();
    } catch (e) {
      errorMsg = e.message;
      render();
    }
  }

  function closePlayer() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    playerItem = null;
    view = "browse";
    render();
  }

  function renderPlayer() {
    root.innerHTML = "";
    const item = playerItem;
    const source = (item.MediaSources || [])[0] || {};
    const mediaSourceId = source.Id || item.Id;
    const streams = source.MediaStreams || [];
    const subtitleStreams = streams.filter((s) => s.Type === "Subtitle");

    const video = el("video", { controls: "", autoplay: "", playsinline: "" });

    const streamUrl = apiKeyUrl(`/Videos/${item.Id}/master.m3u8`, {
      MediaSourceId: mediaSourceId,
      VideoCodec: "h264",
      AudioCodec: "aac,ac3,eac3,mp3,flac,opus",
      MaxAudioChannels: 6,
      DeviceId: store.deviceId,
    });

    for (const s of subtitleStreams) {
      const track = el("track", {
        kind: "subtitles",
        label: s.DisplayTitle || s.Language || `Track ${s.Index}`,
        srclang: s.Language || "und",
        src: apiKeyUrl(`/Videos/${item.Id}/${mediaSourceId}/Subtitles/${s.Index}/Stream.vtt`),
      });
      video.appendChild(track);
    }

    const topbar = el("div", { class: "player-topbar" }, [
      el("button", { class: "btn", onclick: closePlayer }, "← Back"),
      el("div", {}, item.Name),
    ]);

    const wrap = el("div", { class: "player-wrap" }, [topbar, video]);
    root.appendChild(wrap);

    if (window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
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
