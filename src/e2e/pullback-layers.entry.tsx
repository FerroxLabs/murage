// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRoot } from 'react-dom/client';
import App from '../App';
import '../styles.css';
const root = createRoot(document.getElementById('root')!);
window.pullbackMount = () => root.render(<App />);
window.pullbackUnmount = () => root.render(null);
window.pullbackMount();
