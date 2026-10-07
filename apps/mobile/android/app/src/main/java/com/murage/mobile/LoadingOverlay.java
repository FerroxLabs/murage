package com.murage.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;

/** The splash until the page says ready (spec §3.1), and "Still connecting…" (§3.2). */
final class LoadingOverlay extends FrameLayout {
    private final LinearLayout panel;
    private final TextView title;
    private final TextView body;
    private final Button retry;

    LoadingOverlay(Context context, Runnable onRetry, Runnable onChoose) {
        super(context);
        setBackgroundColor(ContextCompat.getColor(context, R.color.murage_canvas));
        setClickable(true); // taps meant for the page underneath stop here
        ImageView mark = new ImageView(context);
        mark.setImageResource(R.drawable.murage_wordmark);
        mark.setContentDescription(context.getString(R.string.loading));
        addView(mark, new LayoutParams(dp(200), dp(44), Gravity.CENTER));

        panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(24), 0, dp(24), 0);
        title = text(context, R.string.connecting, 18, R.color.murage_ink);
        body = text(context, R.string.connecting_body, 15, R.color.murage_ink_secondary);
        retry = button(context, R.string.try_again, true, onRetry);
        panel.addView(title);
        panel.addView(body);
        panel.addView(retry);
        panel.addView(button(context, R.string.your_computers, false, onChoose));
        LayoutParams params = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        params.topMargin = dp(160);
        addView(panel, params);
        retry.setVisibility(GONE);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private TextView text(Context context, int text, int sp, int color) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(ContextCompat.getColor(context, color));
        view.setGravity(Gravity.CENTER);
        view.setPadding(0, dp(6), 0, dp(6));
        return view;
    }

    private Button button(Context context, int text, boolean filled, Runnable action) {
        Button button = new Button(context);
        button.setText(text);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setTextColor(ContextCompat.getColor(context, filled ? R.color.murage_accent_ink : R.color.murage_accent));
        if (filled) button.setBackgroundTintList(ColorStateList.valueOf(ContextCompat.getColor(context, R.color.murage_accent)));
        else button.setBackgroundColor(0);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    void showSplash() {
        animate().cancel();
        setAlpha(1f);
        setVisibility(VISIBLE);
        retry.setVisibility(GONE);
        title.setText(R.string.connecting);
        body.setText(R.string.connecting_body);
    }

    void showSlow() {
        setAlpha(1f);
        setVisibility(VISIBLE);
        retry.setVisibility(VISIBLE);
        title.setText(R.string.slow_title);
        body.setText(R.string.slow_body);
        panel.announceForAccessibility(getContext().getString(R.string.slow_title));
    }

    void hide() {
        if (getVisibility() != VISIBLE) return;
        animate().alpha(0f).setDuration(200).withEndAction(() -> {
            setVisibility(GONE);
            setAlpha(1f);
        });
    }
}
