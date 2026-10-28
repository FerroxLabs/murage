package com.murage.mobile;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import javax.xml.parsers.DocumentBuilderFactory;
import org.json.*;
import org.junit.Test;
import org.w3c.dom.*;

public class ShareResourcesTest {
    private static final String ANDROID = "http://schemas.android.com/apk/res/android";
    private static Path app() { return Files.isDirectory(Paths.get("src/main")) ? Paths.get("") : Paths.get("app"); }
    private static String read(Path path) throws Exception { return new String(Files.readAllBytes(path), StandardCharsets.UTF_8); }
    private static Document xml(Path path) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(path.toFile());
    }
    private static Map<String, String> strings(String folder) throws Exception {
        NodeList nodes = xml(app().resolve("src/main/res/" + folder + "/strings.xml")).getElementsByTagName("string");
        Map<String, String> result = new TreeMap<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element node = (Element) nodes.item(i); String name = node.getAttribute("name");
            if (name.startsWith("share_")) assertNull(name, result.put(name, node.getTextContent().replace("\\'", "'").replace("\\\"", "\"")));
        }
        return result;
    }
    @Test public void eightLocalesMatchReviewedIosCopyWithAndroidPlaceholders() throws Exception {
        String[] locales = {"en", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"};
        String[] folders = {"values", "values-de", "values-es", "values-fr", "values-hi", "values-ja", "values-pt-rBR", "values-zh"};
        Pattern line = Pattern.compile("^\"([^\"]+)\" = \"(.*)\";", Pattern.MULTILINE);
        Map<String, String> english = strings("values");
        assertEquals("Send to Murage", english.get("share_title"));
        assertEquals("Open Murage once to set up sharing.", english.get("share_setup"));
        assertEquals("Couldn't send. Tap to try again.", english.get("share_outbox_failed"));
        assertEquals("Sending...", english.get("share_sending"));
        assertEquals("Couldn't send", english.get("share_outbox_couldnt_send"));
        assertEquals("Open", english.get("share_open"));
        for (int i = 0; i < locales.length; i++) {
            Map<String, String> actual = strings(folders[i]); assertEquals(english.keySet(), actual.keySet());
            Map<String, String> reference = new TreeMap<>();
            for (String file : Arrays.asList("ShareExtension/" + locales[i] + ".lproj/Localizable.strings",
                "MurageShell/Sources/MurageShell/Resources/" + locales[i] + ".lproj/Localizable.strings")) {
                Matcher matcher = line.matcher(read(app().resolve("../../ios/App/" + file)));
                while (matcher.find()) if (matcher.group(1).startsWith("share_") && !matcher.group(1).equals("share_done"))
                    reference.put(matcher.group(1), matcher.group(2).replace("%@", "%1$s").replace("\\\"", "\""));
            }
            for (Map.Entry<String, String> entry : reference.entrySet()) assertEquals(locales[i] + ":" + entry.getKey(), entry.getValue(), actual.get(entry.getKey()));
            for (String copy : actual.values()) {
                assertFalse(copy.trim().isEmpty()); assertFalse(copy.contains("\u2014"));
                assertFalse(Pattern.compile("\\b(?:safe|unsafe|safety)\\b", Pattern.CASE_INSENSITIVE).matcher(copy).find());
            }
            assertTrue(actual.get("share_sent").contains("%1$s")); assertTrue(actual.get("share_new").contains("%1$s"));
        }
    }
    @Test public void manifestHasBothNativeShareFiltersAndNoNewPermissionsOrBackgroundWorker() throws Exception {
        JSONObject types = new JSONObject(read(app().resolve("../../contract/share-types.json")));
        Set<String> expected = new HashSet<>(Arrays.asList("image/*", "image/heic", "image/heif"));
        JSONArray list = types.getJSONArray("androidFilter"); for (int i = 0; i < list.length(); i++) expected.add(list.getString(i));
        Document manifest = xml(app().resolve("src/main/AndroidManifest.xml"));
        Element share = null; NodeList activities = manifest.getElementsByTagName("activity");
        for (int i = 0; i < activities.getLength(); i++) if (".ShareActivity".equals(((Element) activities.item(i)).getAttributeNS(ANDROID, "name"))) share = (Element) activities.item(i);
        assertNotNull(share); assertEquals("true", share.getAttributeNS(ANDROID, "exported"));
        assertEquals("true", share.getAttributeNS(ANDROID, "excludeFromRecents"));
        assertTrue(share.hasAttributeNS(ANDROID, "taskAffinity")); assertEquals("", share.getAttributeNS(ANDROID, "taskAffinity"));
        assertEquals("@style/AppTheme.Sheet", share.getAttributeNS(ANDROID, "theme"));
        NodeList filters = share.getElementsByTagName("intent-filter"); assertEquals(2, filters.getLength());
        Set<String> actions = new HashSet<>();
        for (int i = 0; i < filters.getLength(); i++) {
            Element filter = (Element) filters.item(i); Set<String> offered = new HashSet<>(); NodeList data = filter.getElementsByTagName("data");
            for (int n = 0; n < data.getLength(); n++) offered.add(((Element) data.item(n)).getAttributeNS(ANDROID, "mimeType"));
            assertEquals(expected, offered);
            actions.add(((Element) filter.getElementsByTagName("action").item(0)).getAttributeNS(ANDROID, "name"));
            assertEquals("android.intent.category.DEFAULT", ((Element) filter.getElementsByTagName("category").item(0)).getAttributeNS(ANDROID, "name"));
        }
        assertEquals(new HashSet<>(Arrays.asList("android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE")), actions);
        for (String name : Arrays.asList("ShareActivity", "ShareContent", "SharePicker", "ShareOutboxActivity", "PhoneShareServices", "PhoneShareHTTP")) {
            String source = read(app().resolve("src/main/java/com/murage/mobile/" + name + ".java"));
            assertFalse(source.contains("import android.webkit")); assertFalse(source.contains("loadUrl(")); assertFalse(source.contains("WorkManager"));
        }
        String permissions = read(app().resolve("src/main/AndroidManifest.xml"));
        for (String permission : Arrays.asList("SYSTEM_ALERT_WINDOW", "FOREGROUND_SERVICE", "RECEIVE_BOOT_COMPLETED", "BIND_VOICE_INTERACTION")) assertFalse(permissions.contains(permission));
    }

    @Test public void outboxShortcutUsesOnlyPrivateAliasAndLauncherHasNoOutboxRoute() throws Exception {
        Document manifest = xml(app().resolve("src/main/AndroidManifest.xml"));
        Element alias = null, outbox = null, launcher = null;
        NodeList aliases = manifest.getElementsByTagName("activity-alias");
        for (int i = 0; i < aliases.getLength(); i++) {
            Element candidate = (Element) aliases.item(i);
            if (".OutboxShortcut".equals(candidate.getAttributeNS(ANDROID, "name"))) alias = candidate;
        }
        assertNotNull(alias);
        assertEquals("false", alias.getAttributeNS(ANDROID, "exported"));
        assertEquals(".ShareOutboxActivity", alias.getAttributeNS(ANDROID, "targetActivity"));
        NodeList activities = manifest.getElementsByTagName("activity");
        for (int i = 0; i < activities.getLength(); i++) {
            Element candidate = (Element) activities.item(i);
            if (".ShareOutboxActivity".equals(candidate.getAttributeNS(ANDROID, "name"))) outbox = candidate;
            if (".MainActivity".equals(candidate.getAttributeNS(ANDROID, "name"))) launcher = candidate;
        }
        assertNotNull(outbox); assertEquals("false", outbox.getAttributeNS(ANDROID, "exported"));
        assertNotNull(launcher); assertEquals("true", launcher.getAttributeNS(ANDROID, "exported"));
        NodeList shortcuts = xml(app().resolve("src/main/res/xml/shortcuts.xml")).getElementsByTagName("shortcut");
        boolean found = false;
        for (int i = 0; i < shortcuts.getLength(); i++) {
            Element shortcut = (Element) shortcuts.item(i);
            if (!"outbox".equals(shortcut.getAttributeNS(ANDROID, "shortcutId"))) continue;
            found = true;
            Element intent = (Element) shortcut.getElementsByTagName("intent").item(0);
            assertEquals("com.murage.mobile.OutboxShortcut", intent.getAttributeNS(ANDROID, "targetClass"));
            assertEquals("com.murage.mobile.OUTBOX", intent.getAttributeNS(ANDROID, "action"));
        }
        assertTrue(found);
        String source = read(app().resolve("src/main/java/com/murage/mobile/MainActivity.java"));
        assertFalse(source.contains("ACTION_OUTBOX"));
        assertFalse(source.contains("com.murage.mobile.OUTBOX"));
        assertFalse(source.contains("ShareOutboxActivity.class"));
    }

    @Test public void assistantEntryPointsDeclareOnlyTheirRequiredExports() throws Exception {
        Document manifest = xml(app().resolve("src/main/AndroidManifest.xml"));
        Element assist = null, tile = null;
        NodeList activities = manifest.getElementsByTagName("activity");
        for (int i = 0; i < activities.getLength(); i++) {
            Element activity = (Element) activities.item(i);
            if (".AssistActivity".equals(activity.getAttributeNS(ANDROID, "name"))) assist = activity;
            if (".WorkspaceActivity".equals(activity.getAttributeNS(ANDROID, "name")))
                assertEquals("false", activity.getAttributeNS(ANDROID, "exported"));
        }
        assertNotNull(assist);
        assertEquals("true", assist.getAttributeNS(ANDROID, "exported"));
        assertEquals("@android:style/Theme.NoDisplay", assist.getAttributeNS(ANDROID, "theme"));
        assertFalse(assist.hasAttributeNS(ANDROID, "showWhenLocked"));
        assertEquals(1, assist.getElementsByTagName("intent-filter").getLength());
        assertEquals("android.intent.action.ASSIST", ((Element) assist.getElementsByTagName("action").item(0)).getAttributeNS(ANDROID, "name"));
        assertEquals("android.intent.category.DEFAULT", ((Element) assist.getElementsByTagName("category").item(0)).getAttributeNS(ANDROID, "name"));
        Element alias = null;
        NodeList aliases = manifest.getElementsByTagName("activity-alias");
        for (int i = 0; i < aliases.getLength(); i++) {
            Element candidate = (Element) aliases.item(i);
            if (".AssistShortcut".equals(candidate.getAttributeNS(ANDROID, "name"))) alias = candidate;
        }
        assertNotNull(alias);
        assertEquals("false", alias.getAttributeNS(ANDROID, "exported"));
        assertEquals(".AssistActivity", alias.getAttributeNS(ANDROID, "targetActivity"));
        assertEquals(0, alias.getElementsByTagName("intent-filter").getLength());
        NodeList services = manifest.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            Element service = (Element) services.item(i);
            if (".AskTileService".equals(service.getAttributeNS(ANDROID, "name"))) tile = service;
        }
        assertNotNull(tile);
        assertEquals("true", tile.getAttributeNS(ANDROID, "exported"));
        assertEquals("android.permission.BIND_QUICK_SETTINGS_TILE", tile.getAttributeNS(ANDROID, "permission"));
        assertEquals("android.service.quicksettings.action.QS_TILE", ((Element) tile.getElementsByTagName("action").item(0)).getAttributeNS(ANDROID, "name"));
        NodeList shortcuts = xml(app().resolve("src/main/res/xml/shortcuts.xml")).getElementsByTagName("shortcut");
        boolean hasAsk = false, hasSwitch = false;
        for (int i = 0; i < shortcuts.getLength(); i++) {
            Element shortcut = (Element) shortcuts.item(i);
            if ("switch".equals(shortcut.getAttributeNS(ANDROID, "shortcutId"))) hasSwitch = true;
            if (!"ask".equals(shortcut.getAttributeNS(ANDROID, "shortcutId"))) continue;
            hasAsk = true;
            NodeList intents = shortcut.getElementsByTagName("intent"); assertEquals(1, intents.getLength());
            assertEquals(com.murage.mobile.shell.AssistRoute.SHORTCUT, ((Element) intents.item(0)).getAttributeNS(ANDROID, "targetClass"));
        }
        assertTrue(hasAsk); assertTrue(hasSwitch);
    }

    @Test public void assistantCopyHasAllEightCatalogsAndVerbatimEnglish() throws Exception {
        String[] names = {"tile_ask", "ask_shortcut", "ask_shortcut_bot", "ask_assistant_title",
            "ask_assistant_body", "ask_assistant_settings", "ask_add_tile"};
        String[] english = {"Ask Murage", "Ask", "Ask %1$s", "Use Murage as your assistant app",
            "Long-press home or the power button to ask your bots.", "Choose in Settings", "Add to Quick Settings"};
        for (String folder : Arrays.asList("values", "values-de", "values-es", "values-fr", "values-hi", "values-ja", "values-pt-rBR", "values-zh")) {
            NodeList nodes = xml(app().resolve("src/main/res/" + folder + "/strings.xml")).getElementsByTagName("string");
            Map<String, String> actual = new HashMap<>();
            for (int i = 0; i < nodes.getLength(); i++) {
                Element node = (Element) nodes.item(i);
                if (Arrays.asList(names).contains(node.getAttribute("name")))
                    assertNull(actual.put(node.getAttribute("name"), node.getTextContent()));
            }
            assertEquals(names.length, actual.size());
            for (int i = 0; i < names.length; i++) {
                String copy = actual.get(names[i]); assertNotNull(copy); assertFalse(copy.trim().isEmpty());
                assertFalse(copy.contains("\u2014"));
                assertFalse(Pattern.compile("\\b(?:safe|unsafe|safety)\\b", Pattern.CASE_INSENSITIVE).matcher(copy).find());
                if (folder.equals("values")) assertEquals(english[i], copy);
            }
            assertTrue(actual.get("ask_shortcut_bot").contains("%1$s"));
        }
    }
}
