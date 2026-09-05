import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.novaclip.app',
  appName: 'NovaClip',
  webDir: 'app',
  android: {
    allowMixedContent: true,
    // جلوه‌های بصری نرم‌تر روی نوار وضعیت اندروید
    backgroundColor: '#0b0f1a',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0b0f1a',
      androidScaleType: 'CENTER_CROP',
    },
  },
};

export default config;
