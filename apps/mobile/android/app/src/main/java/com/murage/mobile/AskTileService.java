package com.murage.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

public final class AskTileService extends TileService {
    @Override public void onStartListening() {
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setLabel(getString(R.string.tile_ask));
            tile.setState(Tile.STATE_INACTIVE);
            tile.updateTile();
        }
    }

    @Override public void onClick() {
        super.onClick();
        unlockAndRun(() -> {
            Intent intent = AssistActivity.shortcutIntent(this)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (Build.VERSION.SDK_INT >= 34) {
                PendingIntent open = PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                startActivityAndCollapse(open);
            } else {
                startActivityAndCollapse(intent);
            }
        });
    }
}
