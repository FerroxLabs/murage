// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The frame shown while the terms status loads (and while the terms screens
// download): the app icon centred on the app background. Small on purpose, it
// is part of the first paint. Never a frame of the app itself.

export function BrandFrame() {
  return (
    <div data-brand-frame aria-busy="true" className="flex h-full items-center justify-center bg-app">
      <img src="/app-icon.svg" alt="" width={64} height={64} draggable={false} className="h-16 w-16 opacity-90" />
    </div>
  );
}
