import { type Ref, computed } from 'vue'
import type { SlideBackground } from '@/types/slides'
import { parseAssetUrl } from '@/utils/assetUrl'

// R-11: pending 背景的骨架屏。
// 这个 hook 的契约是返回 style 对象（4 个消费方都只绑 :style），给不了类名，
// 所以颜色和时长照抄 assets/styles/asset-skeleton.scss，改一处要同步改另一处。
// keyframes 是全局的，内联样式可以直接引用。
const PENDING_BACKGROUND_STYLE = {
  backgroundColor: '#eceef0',
  backgroundImage: 'linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, .75) 50%, rgba(255, 255, 255, 0) 100%)',
  backgroundSize: '200% 100%',
  backgroundRepeat: 'no-repeat',
  animation: 'rbAssetShimmer 1.4s linear infinite',
}

// 将页面背景数据转换为css样式
export default (background: Ref<SlideBackground | undefined>) => {
  const backgroundStyle = computed(() => {
    if (!background.value) return { backgroundColor: '#fff' }

    const {
      type,
      color,
      image,
      gradient,
    } = background.value

    // 纯色背景
    if (type === 'solid') return { backgroundColor: color }

    // 背景图模式
    // 包括：背景图、背景大小，是否重复
    else if (type === 'image' && image) {
      const { src, size } = image
      if (!src) return { backgroundColor: '#fff' }

      // R-11: 背景图同样走 asset:// 收口
      const asset = parseAssetUrl(src)

      // 生成中 —— 骨架屏占位
      if (asset.kind === 'pending') return { ...PENDING_BACKGROUND_STYLE }

      // 引用坏了 —— 留白，不要把 asset:// 原串塞给 url() 变成破图
      if (!asset.url) return { backgroundColor: '#fff' }

      if (size === 'repeat') {
        return {
          backgroundImage: `url(${asset.url}`,
          backgroundRepeat: 'repeat',
          backgroundSize: 'contain',
        }
      }
      return {
        backgroundImage: `url(${asset.url}`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: size || 'cover',
      }
    }

    // 渐变色背景
    else if (type === 'gradient' && gradient) {
      const { type, colors, rotate } = gradient
      const list = colors.map(item => `${item.color} ${item.pos}%`)

      if (type === 'radial') return { backgroundImage: `radial-gradient(${list.join(',')}` }
      return { backgroundImage: `linear-gradient(${rotate + 90}deg, ${list.join(',')}` }
    }

    return { backgroundColor: '#fff' }
  })

  return {
    backgroundStyle,
  }
}
