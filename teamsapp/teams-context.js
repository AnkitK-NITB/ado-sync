/* Teams context: who is signed in, and which theme to paint.
 *
 * Both have to survive the tab being opened outside Teams -- during
 * development that is the normal case -- so every call is guarded and the page
 * degrades to something readable rather than blank.
 */
(function () {
  "use strict";

  var listeners = [];

  function applyTheme(theme) {
    // Teams reports "default", "dark" or "contrast".
    var known = { default: 1, dark: 1, contrast: 1 };
    var name = known[theme] ? theme : "default";
    document.documentElement.setAttribute("data-theme", name);
    listeners.forEach(function (fn) {
      try { fn(name); } catch (e) { /* a listener must not break theming */ }
    });
    return name;
  }

  function outsideTeams() {
    // Outside Teams, follow the operating system instead of forcing light.
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    applyTheme(dark && dark.matches ? "dark" : "default");
    if (dark && dark.addEventListener) {
      dark.addEventListener("change", function (e) {
        applyTheme(e.matches ? "dark" : "default");
      });
    }
  }

  /**
   * Whether this page is hosted inside a Teams client.
   *
   * Checked synchronously from the frame position, because nav() runs before
   * the asynchronous Teams initialisation resolves. Being framed is the
   * reliable signal: a Teams tab always is, a browser tab is not.
   */
  function inTeamsFrame() {
    try { return window.parent !== window || window.nativeInterface != null; }
    catch (e) { return true; }
  }

  window.AdoSync = {
    /**
     * Renders navigation when the page is opened outside Teams.
     *
     * Teams draws its own tab strip from the manifest, and drawing another
     * underneath showed every tab twice. In a plain browser there is no strip,
     * so without this the tabs are unreachable.
     */
    nav: function () {
      if (inTeamsFrame()) return;
      var pages = [
        { href: "home.html", label: "Home" },
        { href: "meetings.html", label: "Meetings" },
        { href: "review.html", label: "Review" }
      ];
      var here = (location.pathname.split("/").pop() || "home.html").toLowerCase();
      // The card detail is reached from Review, so keep that tab marked.
      if (here === "meeting.html" || here === "index.html") here = "review.html";
      var el = document.createElement("div");
      el.className = "nav";
      pages.forEach(function (p) {
        var a = document.createElement("a");
        a.href = p.href;
        a.textContent = p.label;
        if (p.href.toLowerCase() === here) a.className = "here";
        el.appendChild(a);
      });
      document.body.insertBefore(el, document.body.firstChild);
    },

    /** Register a callback for theme changes, including the initial one. */
    onTheme: function (fn) { listeners.push(fn); },

    /**
     * Resolves the signed-in user, or null outside Teams.
     * Identity here is display context only -- it is not a token, and the
     * engine never uses a display name to infer an Azure DevOps account.
     */
    init: function (onUser) {
      if (!window.microsoftTeams || !microsoftTeams.app) {
        outsideTeams();
        onUser(null);
        return;
      }

      microsoftTeams.app.initialize()
        .then(function () {
          if (microsoftTeams.app.registerOnThemeChangeHandler) {
            microsoftTeams.app.registerOnThemeChangeHandler(applyTheme);
          }
          return microsoftTeams.app.getContext();
        })
        .then(function (ctx) {
          applyTheme(ctx && ctx.app && ctx.app.theme);
          var u = (ctx && ctx.user) || null;
          onUser(u ? {
            displayName: u.displayName || null,
            upn: u.userPrincipalName || null,
            id: u.id || null,
            tenantId: (ctx.user && ctx.user.tenant && ctx.user.tenant.id) || null
          } : null);
        })
        .catch(function () {
          outsideTeams();
          onUser(null);
        });
    }
  };
})();
