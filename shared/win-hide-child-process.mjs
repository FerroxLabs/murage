// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import installer from './win-hide-child-process.cjs';
export const { installWindowsHide, withHideInherit, stripNodeOptionsExceptHide } = installer;
// Eval descendants already run the inherited require before their body. This
// assertion fails closed if a launcher stripped both inheritance channels.
export const windowsHidePrelude = `if (process.platform === 'win32' && !process[Symbol.for('murage.windowsHide.installed')]) throw Error('Missing Windows hide preload');\nconst withHideInherit = ${withHideInherit.toString()};\n`;
// The build plugin relocates this external import beside each output file.
export const windowsHideImport = 'import "murage:windows-hide";\n';
