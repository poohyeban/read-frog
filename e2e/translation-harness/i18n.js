export const i18n = { t: (key) => key }
export const initI18n = async () => {}
export const setUiLanguage = async () => {}
export const getUiLocale = () => "en"
export const formatUiList = (items) => items.join(", ")
export const translateIn = (_locale, key) => key
export const LocaleBoundary = ({ children }) => children
