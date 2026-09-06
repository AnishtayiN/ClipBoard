/* ============================================================
   NovaClip — global config & constants
   Single source of truth for version + developer links.
   ============================================================ */
(function () {
  'use strict';

  // 👇 در هر انتشار جدید، این نسخه را افزایش دهید (مطابق tag گیت‌هاب)
  const APP_VERSION = '1.0.0';

  const GITHUB_USER = 'AnishtayiN';
  const GITHUB_REPO = 'ClipBoard';
  const GITHUB_URL = 'https://github.com/AnishtayiN/ClipBoard';
  const GITHUB_RELEASES_URL = 'https://github.com/AnishtayiN/ClipBoard/releases';
  const GITHUB_API_RELEASES = 'https://api.github.com/repos/AnishtayiN/ClipBoard/releases/latest';
  const TELEGRAM_USERNAME = 'AnishtayiN';
  const TELEGRAM_URL = 'https://t.me/AnishtayiN';

  window.NovaConfig = {
    version: APP_VERSION,
    versionTag: 'v' + APP_VERSION,
    github: {
      user: GITHUB_USER,
      repo: GITHUB_REPO,
      url: GITHUB_URL,
      releasesUrl: GITHUB_RELEASES_URL,
      apiReleases: GITHUB_API_RELEASES,
    },
    telegram: {
      username: TELEGRAM_USERNAME,
      url: TELEGRAM_URL,
    },
  };
})();
