// Frosted glass behind a rounded actor, like macOS vibrancy.
//
// GNOME's background blur (Shell.BlurMode.BACKGROUND) can only blur a plain
// rectangle, so the corners of a rounded panel would show blurred squares.
// Instead this paints a live copy of the desktop (windows and wallpaper) under
// the panel, blurs that copy, and cuts it to the panel's rounded shape.
//
// Put it in the same Clutter.BinLayout container as the panel, below it: it
// fills whatever size the panel gives the container and asks for none itself.

import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import St from "gi://St";

const CORNER_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
`;
// premultiplied alpha: scale the whole colour by the coverage of the rounded rectangle
const CORNER_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
vec2 q = min(p, size - p);
if (q.x < radius && q.y < radius) {
  float d = length(vec2(radius) - q);
  cogl_color_out *= clamp(radius - d + 0.5, 0.0, 1.0);
}
`;

const RoundedCornersEffect = GObject.registerClass(
class SpotliteRoundedCornersEffect extends Shell.GLSLEffect {
  vfunc_build_pipeline() {
    this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, CORNER_DECLARATIONS, CORNER_CODE, false);
  }

  setShape(width, height, radius) {
    this.set_uniform_float(this.get_uniform_location("size"), 2, [width, height]);
    this.set_uniform_float(this.get_uniform_location("radius"), 1, [radius]);
  }
});

export const Glass = GObject.registerClass(
class SpotliteGlass extends St.Widget {
  constructor({ radius = 18, blur = 36, brightness = 0.85 } = {}) {
    super({ clip_to_allocation: true, x_expand: true, y_expand: true });
    this._radius = radius;
    this._copy = new Clutter.Clone({ source: global.window_group });
    this.add_child(this._copy);
    this.add_effect(new Shell.BlurEffect({ mode: Shell.BlurMode.ACTOR, radius: blur, brightness }));
    this._corners = new RoundedCornersEffect();
    this.add_effect(this._corners);
    this.connect("notify::allocation", () => this.sync());
  }

  // the copy of the desktop is screen-sized; don't let it size the container
  vfunc_get_preferred_width() {
    return [0, 0];
  }

  vfunc_get_preferred_height() {
    return [0, 0];
  }

  /** Line the copy of the desktop up with the real one. Call after the container moves. */
  sync() {
    // a translation, not a position, so this doesn't queue a layout from inside one
    const [x, y] = this.get_transformed_position();
    this._copy.translation_x = -Math.round(x);
    this._copy.translation_y = -Math.round(y);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    this._corners.setShape(this.width, this.height, this._radius * scale);
  }
});
