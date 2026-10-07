package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DiagFileTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static String read(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void appendsIsoStampedLines() throws Exception {
        DiagFile diag = new DiagFile(new File(folder.getRoot(), DiagFile.FILE_NAME), DiagFile.MAX_BYTES);
        assertTrue(diag.append("[call-diag] one", 0));
        assertTrue(diag.append("[call-diag] two", 1500));
        assertEquals("1970-01-01T00:00:00.000Z [call-diag] one\n1970-01-01T00:00:01.500Z [call-diag] two\n", read(diag.file));
    }

    @Test
    public void rotatesAtTheCapKeepingOneOldFile() throws Exception {
        DiagFile diag = new DiagFile(new File(folder.getRoot(), DiagFile.FILE_NAME), 200);
        for (int i = 0; i < 20; i++) diag.append("[call-diag] line " + i + " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 0);
        assertTrue(diag.old().exists());
        assertFalse(new File(diag.old().getPath() + ".1").exists());
        assertTrue(diag.file.length() <= 200);
        assertTrue(diag.old().length() <= 200);
        assertTrue(read(diag.file).contains("line 19 "));
    }

    @Test
    public void defaultCapIsTwoMegabytes() {
        assertEquals(2 * 1024 * 1024, DiagFile.MAX_BYTES);
    }
}
