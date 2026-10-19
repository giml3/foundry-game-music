// Left-hand scene-controls button with a Start / Pause / Stop / On Break /
// Status submenu, using the Foundry v14 object-keyed control shape:
//   controls["bardic-dice"] = { name, order, title, icon, tools: { start: {...}, ... } }
// Tools are `button: true` so clicking acts immediately without becoming
// the active canvas tool.

export function buildSceneControl({ player, openStatus, isGM, localize = (k) => k }) {
  const run = (fn) => () => { void Promise.resolve(fn()).catch((e) => console.error("foundry-game-music |", e)); };
  return {
    name: "bardic-dice",
    order: 99,
    title: localize("BARDICDICE.Control"),
    icon: "fa-solid fa-music",
    visible: true,
    tools: {
      start: {
        name: "start", order: 0, title: localize("BARDICDICE.Start"),
        icon: "fa-solid fa-play", button: true, visible: isGM,
        onChange: run(() => player.start()),
      },
      pause: {
        name: "pause", order: 1, title: localize("BARDICDICE.Pause"),
        icon: "fa-solid fa-pause", button: true, visible: isGM,
        onChange: run(() => player.pauseToggle()),
      },
      stop: {
        name: "stop", order: 2, title: localize("BARDICDICE.Stop"),
        icon: "fa-solid fa-stop", button: true, visible: isGM,
        onChange: run(() => player.stop()),
      },
      break: {
        name: "break", order: 3, title: localize("BARDICDICE.Break"),
        icon: "fa-solid fa-mug-hot", button: true, visible: isGM,
        onChange: run(() => player.onBreak()),
      },
      status: {
        name: "status", order: 4, title: localize("BARDICDICE.Status"),
        icon: "fa-solid fa-circle-info", button: true, visible: true,
        onChange: run(() => openStatus()),
      },
    },
  };
}

export function registerSceneControls(deps) {
  Hooks.on("getSceneControlButtons", (controls) => {
    try {
      const control = buildSceneControl({
        ...deps,
        isGM: game.user?.isGM === true,
        localize: (k) => game.i18n?.localize(k) ?? k,
      });
      if (Array.isArray(controls)) {
        // Pre-v14 fallback only; v14 passes a Record. Kept so a stray compat
        // shim elsewhere cannot crash the toolbar.
        controls.push({ ...control, tools: Object.values(control.tools) });
      } else {
        controls[control.name] = control;
      }
    } catch (e) {
      console.error("foundry-game-music | scene controls failed", e);
    }
  });
}
