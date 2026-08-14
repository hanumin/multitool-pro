// WHY: Vanta.js (github.com/tengbao/vanta) không ship kèm types — khai báo wildcard
// cho mọi effect (fog/waves/net...) dùng ở màn hình login. Giữ API lỏng (options là
// Record) vì mỗi effect nhận bộ options riêng (màu, tốc độ, hình dạng...).
declare module 'vanta/dist/*' {
  interface VantaEffect {
    destroy: () => void
  }
  interface VantaOptions {
    el: HTMLElement | null
    THREE: unknown
    [key: string]: unknown
  }
  // WHY: Hàm factory của effect — nhận el (element chứa canvas) + THREE instance +
  // options (màu/tốc độ...), trả về object có destroy() để dọn khi đổi effect/unmount.
  function vantaEffect(options: VantaOptions): VantaEffect
  export default vantaEffect
}
