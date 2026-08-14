// WHY: Vanta.js (github.com/tengbao/vanta) không ship kèm types — khai báo module
// thủ công cho effect FOG (nền động dạng ánh sáng aurora) dùng ở màn hình login.
// Giữ API lỏng (options là Record) vì mỗi effect nhận bộ options riêng.
declare module 'vanta/dist/vanta.fog.min' {
  interface VantaEffect {
    destroy: () => void
  }
  interface VantaOptions {
    el: HTMLElement | null
    THREE: unknown
    [key: string]: unknown
  }
  // WHY: FOG là factory function của effect — nhận el (element chứa canvas) + THREE
  // instance + options màu/tốc độ, trả về object có destroy() để dọn khi unmount.
  function FOG(options: VantaOptions): VantaEffect
  export default FOG
}
