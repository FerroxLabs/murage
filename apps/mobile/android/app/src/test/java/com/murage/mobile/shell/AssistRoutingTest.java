package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.io.File;
import java.util.*;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AssistRoutingTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static PhoneAskContract.TargetBot bot(String id) {
        return new PhoneAskContract.TargetBot(id, id, null, "thread-" + id);
    }
    private static PhoneAskContract.TargetsAnswer targets() {
        return new PhoneAskContract.TargetsAnswer("desk", Arrays.asList(bot("ember"), bot("lena")), Collections.emptyList());
    }

    @Test public void exportedEntryIgnoresAllExtrasWithoutReadingTheBundle() {
        for (String component : Arrays.asList(null, "com.murage.mobile.AssistActivity", "other.AssistShortcut")) {
            AssistRoute route = new AssistRoute(component, key -> { throw new AssertionError("read exported extras"); });
            assertNull(route.workspace); assertNull(route.bot);
            assertEquals("lena", ShareTargets.resolveBot(targets(), route.bot, "lena"));
            assertNull(ShareTargets.resolveBot(targets(), route.bot, null));
        }
    }

    @Test public void privateAliasHonoursOnlyTheTwoRoutingExtras() {
        Map<String, String> extras = new HashMap<>();
        extras.put(AssistRoute.EXTRA_WORKSPACE, "https://desk.example.test");
        extras.put(AssistRoute.EXTRA_BOT, "ember");
        extras.put("android.intent.extra.TEXT", "message");
        Set<String> read = new HashSet<>();
        AssistRoute route = new AssistRoute(AssistRoute.SHORTCUT, key -> { read.add(key); return extras.get(key); });
        assertEquals("https://desk.example.test", route.workspace);
        assertEquals("ember", ShareTargets.resolveBot(targets(), route.bot, "lena"));
        assertEquals(new HashSet<>(Arrays.asList(AssistRoute.EXTRA_WORKSPACE, AssistRoute.EXTRA_BOT)), read);
    }

    @Test public void knownShortcutWinsOverLastUsed() {
        assertEquals("ember", ShareTargets.resolveBot(targets(), "ember", "lena"));
    }
    @Test public void unknownShortcutFallsBackToKnownLastUsed() {
        assertEquals("lena", ShareTargets.resolveBot(targets(), "deleted", "lena"));
        assertEquals("lena", ShareTargets.resolveBot(targets(), null, "lena"));
    }
    @Test public void noKnownSelectionOpensListRatherThanFirstBot() {
        assertNull(ShareTargets.resolveBot(targets(), "deleted", "also-deleted"));
        assertNull(ShareTargets.resolveBot(targets(), null, null));
        assertNull(ShareTargets.resolveBot(null, "ember", "lena"));
        assertEquals("", OpenHash.compose(ShareTargets.resolveBot(targets(), "deleted", null)));
    }
    @Test public void evenCachedIdsMustBeValidated() {
        String injected = "ember&again=message&text=send";
        PhoneAskContract.TargetsAnswer poisoned = new PhoneAskContract.TargetsAnswer("desk",
            Arrays.asList(bot(injected), bot("lena")), Collections.emptyList());
        assertEquals("lena", ShareTargets.resolveBot(poisoned, injected, "lena"));
        assertNull(ShareTargets.resolveBot(poisoned, injected, injected));
    }
    @Test public void composeHashIsExactAndBounded() {
        assertEquals("#open=bot:Ember_09-a&compose=1", OpenHash.compose("Ember_09-a"));
        String max = String.join("", Collections.nCopies(128, "a"));
        assertEquals("#open=bot:" + max + "&compose=1", OpenHash.compose(max));
        for (String invalid : Arrays.asList(null, "", max + "a", "../ember", "bot:ember", "ember&compose=0",
                "ember#open=other", "ember%26text=x", "ember?text=x", "ember\n", " ember", "é", "机器人", "a\u0000")) {
            assertFalse(String.valueOf(invalid), OpenHash.validBot(invalid));
            assertEquals("", OpenHash.compose(invalid));
        }
        assertTrue(OpenHash.isCompose(""));
        assertTrue(OpenHash.isCompose(OpenHash.compose("ember")));
        for (String invalid : Arrays.asList(null, "#open=ember", "#open=bot:ember&compose=1&text=hello",
                "#open=bot:ember&compose=0", "#open=bot:ember%26again=x&compose=1", "#open=bot:ember&compose=1\n"))
            assertFalse(String.valueOf(invalid), OpenHash.isCompose(invalid));
    }
    @Test public void recentBotsAreKnownDistinctOrderedAndCapped() {
        PhoneAskContract.TargetsAnswer value = new PhoneAskContract.TargetsAnswer("desk",
            Arrays.asList(bot("a"), bot("b"), bot("c"), bot("d"), bot("e"), bot("f")),
            Arrays.asList(new PhoneAskContract.RecentTarget("b", "t1", "", 1),
                new PhoneAskContract.RecentTarget("d", "t2", "", 4),
                new PhoneAskContract.RecentTarget("c", "t3", "", 3),
                new PhoneAskContract.RecentTarget("d", "t4", "", 5),
                new PhoneAskContract.RecentTarget("e", "t5", "", 2),
                new PhoneAskContract.RecentTarget("gone", "t6", "", 99)));
        List<String> ids = new ArrayList<>();
        for (PhoneAskContract.TargetBot bot : ShareTargets.recentBots(value, "a")) ids.add(bot.id);
        assertEquals(Arrays.asList("a", "d", "c", "e"), ids);
        assertTrue(ShareTargets.recentBots(null, "a").isEmpty());
        assertTrue(ShareTargets.recentBots(targets(), null).isEmpty());
    }
    @Test public void cacheOnlyLookupNeedsNeitherTokenNorTransportAndExpires() throws Exception {
        File root = temporary.newFolder();
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://desk.example.test");
        File file = new File(new File(root, "targets"), ShareFiles.workspace(origin) + ".json");
        long now = 1_800_000_000_000L;
        ShareFiles.json(file, new JSONObject().put("v", 1).put("origin", origin.serialized())
            .put("fetchedAt", now).put("targets", targets().encode()));
        assertEquals("ember", ShareTargets.resolveBot(ShareTargets.readCached(root, origin, now), "ember", null));
        assertNull(ShareTargets.readCached(root, origin, now - 1));
        assertNull(ShareTargets.readCached(root, origin, now + ShareTargets.MAX_AGE + 1));
        ShareFiles.delete(file);
        assertNull(ShareTargets.readCached(root, origin, now));
    }
}
