/**
 * sounds.js — Sonidos sintéticos vía Web Audio API.
 * Misma firma que la app Electron (utils/sounds.ts) para mantener consistencia UX.
 * Sin archivos externos.
 */
(function () {
  let _ctx = null

  function getCtx () {
    if (typeof window === 'undefined') return null
    if (!_ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        _ctx = new AC()
      } catch {
        return null
      }
    }
    if (_ctx.state === 'suspended') {
      _ctx.resume().catch(() => {})
    }
    return _ctx
  }

  function tone ({ frequency, duration, type = 'sine', volume = 0.4, startTime = 0 }) {
    const ctx = getCtx()
    if (!ctx) return
    const now = ctx.currentTime + startTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(volume, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + duration + 0.01)
  }

  window.sounds = {
    /** Tick suave al marcar revisado */
    reviewed () {
      tone({ frequency: 800, duration: 0.06, type: 'sine', volume: 0.4 })
    },
    /** Tono bajo de advertencia al marcar faltante */
    missing () {
      tone({ frequency: 320, duration: 0.1, type: 'triangle', volume: 0.4 })
    },
    /** Campanita ascendente al finalizar revisión completa */
    finalize () {
      tone({ frequency: 660, duration: 0.12, type: 'sine', volume: 0.4 })
      tone({ frequency: 880, duration: 0.18, type: 'sine', volume: 0.4, startTime: 0.08 })
    },
    /** Tono neutro al deshacer */
    undo () {
      tone({ frequency: 500, duration: 0.08, type: 'sine', volume: 0.4 })
    }
  }
})()
