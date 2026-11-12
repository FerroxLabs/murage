// Synthetic loading probe: no account, configuration, login or network access.
import java.nio.file.*;
import java.sql.*;
class SignalNativeLoaded {
  public static void main(String[] args) throws Exception {
    Class.forName("org.signal.libsignal.internal.Native");
    Class.forName("org.sqlite.JDBC");
    try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:")) {
      try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("select 7")) {
        if (!r.next() || r.getInt(1) != 7) throw new AssertionError("sqlite did not execute");
      }
    }
    String maps = Files.readString(Path.of("/proc/self/maps"));
    for (String library : new String[]{"libsignal_jni.so", "libsqlitejdbc.so"}) {
      String path = Path.of(args[0], "native", library).toRealPath().toString();
      if (!maps.lines().anyMatch(line -> line.endsWith(" " + path))) throw new AssertionError("not loaded from pinned native directory: " + library);
      System.out.println("LOADED " + path);
    }
    try (var paths = Files.walk(Path.of(System.getProperty("java.io.tmpdir")))) {
      if (paths.anyMatch(p -> p.toString().matches(".*\\.(so|dll|dylib|jnilib)$"))) throw new AssertionError("extracted native in tmp");
    }
    System.out.println("NO_EXTRACTED_NATIVE; SQLITE_QUERY=7");
  }
}
