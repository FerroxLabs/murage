// First run, step 1 (2026-09-27 first-run spec): the phone's own launch screen
// shows the Murage mark on the canvas colour, and the launcher follows it with
// no white flash. Native resources, pinned by reading them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const RES = "../android/app/src/main/res/";

/** styles.css --app, light and dark. */
const CANVAS = { light: "#f7f7f7", dark: "#0a0a0a" };

describe("splash", () => {
  it("launcher CSS is the canvas the splash uses", () => {
    const css = read("./styles.css");
    expect(css).toMatch(new RegExp(`:root \\{[^}]*--app: ${CANVAS.light};`));
    expect(css).toMatch(new RegExp(`prefers-color-scheme: dark\\)[^}]*--app: ${CANVAS.dark};`));
  });

  it("iOS: LaunchScreen.storyboard centres the Murage mark on LaunchCanvas, light and dark", () => {
    const board = read("../ios/App/App/Base.lproj/LaunchScreen.storyboard");
    expect(board).toContain('launchScreen="YES"');
    expect(board).toMatch(/<imageView[^>]*image="MurageWordmark"/);
    expect(board).toContain('<color key="backgroundColor" name="LaunchCanvas"/>');
    expect(read("../ios/App/App/Info.plist")).toMatch(/<key>UILaunchStoryboardName<\/key>\s*<string>LaunchScreen<\/string>/);
    const colors = JSON.parse(read("../ios/App/App/Assets.xcassets/LaunchCanvas.colorset/Contents.json")).colors as {
      appearances?: { value: string }[];
      color: { components: { red: string } };
    }[];
    const hex = (c: (typeof colors)[number]) => `#${Math.round(Number(c.color.components.red) * 255).toString(16).padStart(2, "0").repeat(3)}`;
    expect(colors.map((c) => [c.appearances?.[0]?.value ?? "light", hex(c)])).toEqual([
      ["light", CANVAS.light],
      ["dark", CANVAS.dark],
    ]);
    const mark = JSON.parse(read("../ios/App/App/Assets.xcassets/MurageWordmark.imageset/Contents.json")).images as { filename: string }[];
    expect(mark.map((i) => i.filename)).toEqual(["wordmark-light.png", "wordmark-dark.png"]);
  });

  it("iOS: the launcher's view and WebView are the canvas, so nothing white shows before the page paints", () => {
    const controller = read("../ios/App/App/MobileViewController.swift");
    expect(controller).toContain("view.backgroundColor = ShellColors.canvas");
    expect(controller).toContain("bridge?.webView?.isOpaque = false");
    expect(controller).toContain("bridge?.webView?.backgroundColor = ShellColors.canvas");
    expect(read("../ios/App/App/SceneDelegate.swift")).toContain("window?.backgroundColor = ShellColors.canvas");
  });

  it("Android: Theme.SplashScreen shows the Murage mark on murage_canvas, light and dark", () => {
    for (const styles of [read(`${RES}values/styles.xml`), read(`${RES}values-v31/styles.xml`)]) {
      expect(styles).toMatch(/<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">/);
      expect(styles).toContain('<item name="windowSplashScreenBackground">@color/murage_canvas</item>');
      expect(styles).toContain('<item name="windowSplashScreenAnimatedIcon">@drawable/murage_splash_icon</item>');
      expect(styles).toContain('<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>');
    }
    expect(read(`${RES}drawable/murage_splash_icon.xml`)).toContain('android:src="@drawable/murage_splash_mark"');
    expect(read(`${RES}values/appearance.xml`)).toContain(`<color name="murage_canvas">${CANVAS.light}</color>`);
    expect(read(`${RES}values-night/appearance.xml`)).toContain(`<color name="murage_canvas">${CANVAS.dark}</color>`);
    expect(read(`${RES}values/styles.xml`)).toMatch(/<style name="AppTheme"[\s\S]*<item name="android:windowBackground">@color\/murage_canvas<\/item>/);
    expect(read("../android/app/src/main/AndroidManifest.xml")).toContain('android:theme="@style/AppTheme.NoActionBarLaunch"');
  });

  it("Android: the launcher's WebView is the canvas, not WebView white, when the splash hands over", () => {
    const main = read("../android/app/src/main/java/com/murage/mobile/MainActivity.java");
    const created = main.indexOf("super.onCreate(state);\n        // Capacitor always loads");
    expect(created).toBeGreaterThan(-1);
    expect(main.indexOf("getBridge().getWebView().setBackgroundColor(getColor(R.color.murage_canvas));")).toBeGreaterThan(created);
  });
});
