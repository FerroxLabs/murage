package android.text;

/**
 * Test-only stand-in for android.jar's stub, which throws "not mocked".
 * MlKitException's constructor checks its message with isEmpty, and
 * QrScannerTest builds real MlKitExceptions. Nothing else here uses TextUtils;
 * a test that needs more of it fails loudly with NoSuchMethodError.
 */
public final class TextUtils {
    private TextUtils() {}

    public static boolean isEmpty(CharSequence text) {
        return text == null || text.length() == 0;
    }
}
