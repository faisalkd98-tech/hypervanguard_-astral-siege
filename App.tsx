/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { GameCanvas } from './components/GameCanvas';

export default function App() {
  return (
    <main className="w-screen h-screen overflow-hidden bg-[#05070f] flex items-center justify-center p-0 m-0">
      <div className="w-full h-full relative flex items-center justify-center">
        <GameCanvas />
      </div>
    </main>
  );
}
