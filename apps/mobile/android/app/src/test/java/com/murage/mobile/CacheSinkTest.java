package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Test;

/** P20: one fresh directory per transfer, cleared after the hand-off, leftovers swept by age. */
public class CacheSinkTest {
    @org.junit.Before public void quietLog() {
        new LogCapture();
    }

    private static File base() throws IOException {
        return Files.createTempDirectory("murage-saves-test").toFile();
    }

    @Test public void eachTransferGetsItsOwnDirectoryAndThePageIdIsNeverAPath() throws Exception {
        File base = base();
        CacheSink sink = new CacheSink(base);
        File a = sink.create("../../etc", "report.pdf");
        File b = sink.create("../../etc", "report.pdf");
        assertNotEquals(a.getParentFile(), b.getParentFile());
        assertEquals(base, a.getParentFile().getParentFile());
        assertEquals("report.pdf", a.getName());
        assertFalse(a.getParentFile().getName().contains("etc"));
    }

    @Test public void appendsAndDiscardsTheWholeDirectory() throws Exception {
        CacheSink sink = new CacheSink(base());
        File file = sink.create("t", "a.txt");
        sink.append(new byte[] {1, 2}, file);
        sink.append(new byte[] {3}, file);
        assertEquals(3, file.length());
        sink.discard(file);
        assertFalse(file.getParentFile().exists());
    }

    @Test public void prunesOnlyOldDirectoriesThatAreNotInUse() throws Exception {
        LogCapture log = new LogCapture();
        File base = base();
        CacheSink sink = new CacheSink(base);
        File live = sink.create("live", "a.txt");
        File stale = new File(base, "left-by-a-dead-process");
        assertTrue(stale.mkdirs());
        File staleFile = new File(stale, "b.txt");
        assertTrue(staleFile.createNewFile());
        long old = System.currentTimeMillis() - CacheSink.MAX_AGE_MS - 60_000;
        assertTrue(staleFile.setLastModified(old));
        assertTrue(stale.setLastModified(old));
        assertTrue(live.setLastModified(old));
        assertTrue(live.getParentFile().setLastModified(old));
        File recent = new File(base, "recent");
        assertTrue(recent.mkdirs());

        sink.create("another", "c.txt"); // create() prunes first

        assertFalse(stale.exists());
        assertTrue(live.exists()); // in use by this process, however old
        assertTrue(recent.exists());
        assertTrue(log.all().contains("saves pruned files=1"));
    }

    @Test public void aDiscardedDirectoryIsNoLongerInUse() throws Exception {
        File base = base();
        CacheSink sink = new CacheSink(base);
        File file = sink.create("t", "a.txt");
        CacheSink.delete(file.getParentFile());
        assertFalse(CacheSink.inUse(file.getParentFile()));
    }

    @Test public void aFailedCreateLeavesNothingBehind() throws Exception {
        // FileNames.safe never passes these; the sink refuses them anyway and cleans up.
        for (String name : new String[] {"sub/x", "../../escaped", "../x", "."}) {
            File base = base();
            CacheSink sink = new CacheSink(base);
            try {
                sink.create("t", name);
                fail("created " + name);
            } catch (IOException expected) {
                // refused
            }
            File[] left = base.listFiles();
            assertEquals(name, 0, left == null ? -1 : left.length);
            assertFalse(name, new File(base.getParentFile(), "escaped").exists());
            assertFalse(name, new File(base, "x").exists());
        }
    }
}
