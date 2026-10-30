import React, { useEffect, useState, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import en from 'antd/locale/en_US'
import ru from 'antd/locale/ru_RU'
import vi from 'antd/locale/vi_VN'
import th from 'antd/locale/th_TH'
import ptBR from 'antd/locale/pt_BR'
import fr from 'antd/locale/fr_FR'
import uk from 'antd/locale/uk_UA'
import es from 'antd/locale/es_ES'
import tr from 'antd/locale/tr_TR'
import ja from 'antd/locale/ja_JP'
import hi from 'antd/locale/hi_IN'
import { getLocale, resolveLocale, setLocale, subscribeLocale } from '../../shared/i18n'
import App from './App'
import './styles.css'

const COLOR_MODE_STORAGE_KEY = 'prism-browser-color-mode'

function initialColorMode(): 'light' | 'dark' {
  const mode = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
  return mode
}

function PrismApplication() {
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(initialColorMode)
  const locale = useSyncExternalStore(subscribeLocale, getLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    document.documentElement.dataset.theme = colorMode
    document.documentElement.style.colorScheme = colorMode
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, colorMode)
  }, [colorMode])

  const dark = colorMode === 'dark'

  return (
    <ConfigProvider
      locale={{ 'zh-CN': zhCN, 'zh-TW': zhTW, en, ru, vi, th, 'pt-BR': ptBR, fr, uk, es, tr, ja, hi }[locale]}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? '#7eaa97' : '#315c50',
          colorText: dark ? '#e7ebe5' : '#262a28',
          colorTextSecondary: dark ? '#a4ada4' : '#777c76',
          colorBgBase: dark ? '#171c1a' : '#ffffff',
          colorBgLayout: dark ? '#121715' : '#f8f9f6',
          colorBgContainer: dark ? '#202724' : '#ffffff',
          colorBorder: dark ? '#3b4640' : '#e1e5dd',
          colorBorderSecondary: dark ? '#303934' : '#eceee8',
          colorSuccess: dark ? '#76ab83' : '#44745a',
          colorInfo: dark ? '#7eaa97' : '#315c50',
          borderRadius: 8,
          fontSize: 14,
          fontSizeSM: 12,
          fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        },
        components: {
          Button: { controlHeight: 36 },
          Input: { controlHeight: 36 },
          Select: { controlHeight: 36 },
          Table: {
            headerBg: dark ? '#1c231f' : '#fafbf8',
            headerColor: dark ? '#aeb7ae' : '#848980',
            rowHoverBg: dark ? '#27312c' : '#f6f9f1'
          }
        }
      }}
    >
      <App colorMode={colorMode} onColorModeChange={setColorMode} />
    </ConfigProvider>
  )
}

async function mount(): Promise<void> {
  const selected = await window.browserApi.uiLanguage.get().catch(() => 'en')
  setLocale(resolveLocale(selected))
  document.documentElement.lang = getLocale()
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PrismApplication /></React.StrictMode>)
}
void mount()
