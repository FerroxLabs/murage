package com.murage.mobile;

import android.content.Context;
import androidx.appcompat.app.AlertDialog;
import java.util.function.Consumer;

/** N4 supplies offer.provider.name, then records offer.provider.id after Allow. */
final class PhoneDataSharingSheet {
    static AlertDialog show(Context context, String providerName, Consumer<Boolean> answer) {
        return show(context, providerName, null, answer);
    }
    static AlertDialog show(Context context, String providerName, String workspaceName, Consumer<Boolean> answer) {
        String message = context.getString(R.string.phone_sharing_generic);
        if (providerName != null) message += "\n\n" + context.getString(R.string.phone_provider_label,
            PhoneDataSharingText.providerLine(providerName, context.getString(R.string.phone_provider_fallback)));
        if (workspaceName != null) message += "\n\n" + PhoneDataSharingText.plain(workspaceName, 120, 0);
        return new AlertDialog.Builder(context).setTitle(R.string.phone_sharing_title).setMessage(message)
            .setPositiveButton(R.string.phone_allow, (dialog, which) -> answer.accept(true))
            .setNegativeButton(R.string.phone_not_now, (dialog, which) -> answer.accept(false))
            .setCancelable(false).show();
    }
}
