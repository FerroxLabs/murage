package com.murage.mobile;

import android.content.*;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import com.murage.mobile.shell.*;
import java.io.*;
import java.util.*;

/** The only content-provider adapter. No URI is retained after the durable body is prepared. */
final class ShareContent {
    final String text, url, preview;
    final List<Uri> streams;
    ShareContent(Context context, Intent intent) throws IOException {
        if (!Intent.ACTION_SEND.equals(intent.getAction()) && !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) throw new ShareBody.InputError("share_type");
        CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        ShareBody.TextInput input = new ShareBody.TextInput(extra == null ? null : extra.toString(), subject);
        text = input.text; url = input.url; preview = input.preview;
        streams = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> values = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (values != null) streams.addAll(values);
        } else {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (stream != null) streams.add(stream);
        }
        if (streams.isEmpty() && intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) streams.add(clip.getItemAt(i).getUri());
        }
        ShareBody.count(streams.size());
        for (Uri uri : streams) ShareBody.externalStream(uri == null ? null : uri.getScheme(),
            uri == null ? null : uri.getAuthority(), context.getPackageName(), authority -> {
                ProviderInfo provider = context.getPackageManager().resolveContentProvider(authority, 0);
                return provider == null ? null : provider.packageName;
            });
        if (text == null && url == null && streams.isEmpty()) throw new ShareBody.InputError("share_type");
    }
    List<ShareBody.Attachment> attachments(ContentResolver resolver) throws IOException {
        List<ShareBody.Attachment> result = new ArrayList<>();
        for (Uri uri : streams) {
            String mime = resolver.getType(uri);
            if (!ShareBody.accepts(mime)) throw new ShareBody.InputError("share_type");
            boolean image = mime.startsWith("image/");
            String name = null;
            try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            final String expected = mime;
            if (image) {
                // All images use the iOS thumbnail policy, including HEIC/HEIF to JPEG 0.85.
                String stem = ShareBody.name(name, result.size() + 1);
                if (stem.length() > 250) stem = stem.substring(0, 250);
                result.add(new ShareBody.Attachment(stem + ".jpg", "image/jpeg", file -> image(resolver, uri, expected, file)));
            } else {
                result.add(new ShareBody.Attachment(name, mime, file -> ShareBody.stream(resolver.openInputStream(uri), file,
                    PhoneAskContract.ShareLimits.FILE_MAX_BYTES, "share_file_large")));
            }
        }
        return result;
    }
    private static void image(ContentResolver resolver, Uri uri, String expected, File file) throws IOException {
        Bitmap bitmap;
        if (Build.VERSION.SDK_INT >= 28) {
            bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri), (decoder, info, source) -> {
                String actual = info.getMimeType();
                if (!expected.equals(actual) && !(Arrays.asList("image/heic", "image/heif").contains(expected)
                    && Arrays.asList("image/heic", "image/heif").contains(actual))) throw new IllegalArgumentException("image type");
                int[] size = ShareBody.imageSize(info.getSize().getWidth(), info.getSize().getHeight());
                decoder.setTargetSize(size[0], size[1]); decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
        } else {
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            try (InputStream in = resolver.openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || !expected.equals(bounds.outMimeType)) throw new ShareBody.InputError("share_type");
            BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = ShareBody.imageSample(bounds.outWidth, bounds.outHeight);
            try (InputStream in = resolver.openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(in, null, options); }
        }
        if (bitmap == null) throw new ShareBody.InputError("share_type");
        try (FileOutputStream out = new FileOutputStream(file)) {
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, ShareBody.JPEG_QUALITY, out)) throw new IOException("image encode");
            out.getFD().sync();
        } finally { bitmap.recycle(); }
        if (file.length() > PhoneAskContract.ShareLimits.IMAGE_MAX_BYTES) throw new ShareBody.InputError("share_photo_large");
    }
}
