; Extra installer pages (electron-builder includes this file via nsis.include).
; A welcome page first, so the installer opens on the GameVault artwork
; (installer/sidebar.bmp) instead of a plain options page.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to GameVault 2.0"
  !define MUI_WELCOMEPAGE_TEXT "This will set up GameVault on your PC.$\r$\n$\r$\nIf you already use GameVault, your library, playtime and settings stay as they are.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend
