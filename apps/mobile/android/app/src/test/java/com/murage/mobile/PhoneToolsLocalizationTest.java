package com.murage.mobile;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import static org.junit.Assert.*;

public class PhoneToolsLocalizationTest {
    // The design gives a count, not names. Match the eight distinct languages
    // in src/locales/index.ts; pt is an alias for pt-BR, not a ninth language.
    private static final String[] LOCALES = {"en", "de", "es", "fr", "hi", "ja", "pt-rBR", "zh"};
    private static final Pattern PLACEHOLDER = Pattern.compile("%(?:[1-9][0-9]*\\$)?[a-zA-Z]|%%");

    private Path resources() {
        // Gradle normally sets the project directory to app; also allow the
        // Android project root when invoking the test through an IDE.
        Path path = Paths.get("src/main/res");
        return Files.isDirectory(path) ? path : Paths.get("app/src/main/res");
    }

    private Map<String, String> strings(String folder) throws Exception {
        Path path = resources().resolve(folder).resolve("strings.xml");
        assertTrue("Missing catalog: " + path, Files.isRegularFile(path));
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        NodeList entries = factory.newDocumentBuilder().parse(path.toFile()).getElementsByTagName("string");
        Map<String, String> values = new LinkedHashMap<>();
        for (int i = 0; i < entries.getLength(); i++) {
            Element entry = (Element) entries.item(i);
            String key = entry.getAttribute("name");
            if (key.startsWith("phone_")) {
                assertNull("Duplicate " + key + " in " + folder, values.put(key, entry.getTextContent()));
            }
        }
        return values;
    }

    private List<String> placeholders(String value) {
        Matcher matcher = PLACEHOLDER.matcher(value);
        List<String> found = new ArrayList<>();
        while (matcher.find()) found.add(matcher.group());
        Collections.sort(found);
        return found;
    }

    @Test public void everyPhoneKeyAndPlaceholderExistsInEveryLocale() throws Exception {
        Map<String, String> english = strings("values");
        assertTrue(english.size() >= 44);
        assertEquals(english, strings("values-en"));
        for (String locale : LOCALES) {
            Map<String, String> translated = strings("values-" + locale);
            assertEquals(locale, english.keySet(), translated.keySet());
            for (Map.Entry<String, String> entry : english.entrySet()) {
                String key = entry.getKey(), actual = translated.get(key);
                assertFalse(locale + ": " + key, actual.trim().isEmpty());
                assertEquals(locale + ": " + key, placeholders(entry.getValue()), placeholders(actual));
                assertFalse(locale + ": " + key, actual.contains("\u2014"));
            }
            String used = String.format(Locale.ROOT, translated.get("phone_job_used"), "BOT_MARKER", "CAPABILITY_MARKER");
            assertTrue(locale, used.contains("BOT_MARKER"));
            assertTrue(locale, used.contains("CAPABILITY_MARKER"));
        }
    }
}
