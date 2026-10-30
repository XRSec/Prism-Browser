import { useEffect, useState } from 'react'
import { message } from 'antd'
import { t, translateMessage as mt } from '../../shared/i18n'
import { ArrowLeftOutlined, ArrowRightOutlined, PauseOutlined, CaretRightOutlined, ExportOutlined } from '@ant-design/icons'
import type { AdvertisementItem, AdvertisementStatus } from '../../shared/types'

function advertisementVisible(item: AdvertisementItem, now: number): boolean {
  if (!item.enabled) return false
  if (item.startsAt && Date.parse(item.startsAt) > now) return false
  if (item.endsAt && Date.parse(item.endsAt) < now) return false
  return true
}

function localizedAdvertisement(item: AdvertisementItem): AdvertisementItem {
  return item
}

export function AdvertisementRail() {
  const [status, setStatus] = useState<AdvertisementStatus>({ state: 'empty', items: [] })
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [now, setNow] = useState(Date.now())
  const [reducedMotion, setReducedMotion] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  useEffect(() => {
    let live = true
    void window.browserApi.advertisements.check().then((next) => {
      if (live) setStatus(next)
    }).catch(() => undefined)

    const tick = setInterval(() => {
      setNow(Date.now())
      void window.browserApi.advertisements.status().then((next) => {
        if (live) setStatus(next)
      }).catch(() => undefined)
    }, 5_000)

    const visibility = () => setHidden(document.hidden)
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => setReducedMotion(media.matches)
    motion()
    media.addEventListener('change', motion)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      live = false
      clearInterval(tick)
      media.removeEventListener('change', motion)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  const items = status.items.filter((item) => advertisementVisible(item, now)).map(localizedAdvertisement)
  const activeIndex = items.length ? index % items.length : 0
  const active = items[activeIndex]
  const stopped = paused || hovered || focused || hidden || reducedMotion

  useEffect(() => {
    if (stopped || items.length < 2 || !active) return
    const timer = setTimeout(() => setIndex((value) => (value + 1) % items.length), active.durationSeconds * 1000)
    return () => clearTimeout(timer)
  }, [active?.id, active?.durationSeconds, activeIndex, stopped, items.length])

  const change = (step: number) => setIndex((activeIndex + step + items.length) % items.length)

  return (
    <section
      className={`advertisement-rail tone-${active?.tone ?? 'neutral'}`}
      aria-label={t("精选内容")}
      aria-roledescription={t("轮播")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false)
      }}
    >
      {contextHolder}
      {active ? (
        <>
          <span className="rail-label">{t("广告")}</span>
          <button
            className="rail-content"
            onClick={() => void window.browserApi.advertisements.open(active.id).catch((error) =>
              messageApi.error(error instanceof Error ? mt(error.message) : t("暂时无法打开链接"))
            )}
          >
            <strong>{active.title}</strong>
            <span className="rail-description">{active.body}</span>
            <span className="rail-link">
              {active.label}
              <ExportOutlined />
            </span>
          </button>
          {items.length > 1 && (
            <div className="rail-controls">
              <button aria-label={t("上一条广告")} onClick={() => change(-1)}><ArrowLeftOutlined /></button>
              <span className="rail-count">
                {activeIndex + 1}
                <i>/</i>
                {items.length}
              </span>
              <button aria-label={t("下一条广告")} onClick={() => change(1)}><ArrowRightOutlined /></button>
              <button
                aria-label={paused ? t("继续轮播") : t("暂停轮播")}
                aria-pressed={paused}
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? <CaretRightOutlined /> : <PauseOutlined />}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <span className="rail-label">PRISM</span>
          <span className="rail-idle">{t("独立的浏览器身份，有序的工作空间。")}</span>
          <span className="rail-local">LOCAL FIRST</span>
        </>
      )}
    </section>
  )
}
