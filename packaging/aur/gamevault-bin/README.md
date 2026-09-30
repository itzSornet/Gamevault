# GameVault AUR Package (`gamevault-bin`)

This directory contains the Arch User Repository (AUR) packaging files for GameVault.

## Package Details
- **Package Name**: `gamevault-bin`
- **Version**: `1.3.0`
- **Target**: Arch Linux, CachyOS, EndeavourOS, Manjaro, etc.
- **Upstream Release**: [GitHub Releases](https://github.com/itzSornet/Gamevault/releases)

---

## Publishing to AUR (For Maintainer)

### 1. One-time Setup
1. Register an account on [https://aur.archlinux.org/](https://aur.archlinux.org/)
2. Add your public SSH key (`cat ~/.ssh/id_ed25519.pub` or `id_rsa.pub`) to your AUR profile settings.

### 2. Clone the AUR repository
```bash
git clone ssh://aur@aur.archlinux.org/gamevault-bin.git /tmp/gamevault-bin-aur
```

### 3. Copy packaging files and generate `.SRCINFO`
```bash
cp PKGBUILD gamevault.desktop /tmp/gamevault-bin-aur/
cd /tmp/gamevault-bin-aur

# Generate .SRCINFO
makepkg --printsrcinfo > .SRCINFO
```

### 4. Commit and Push to AUR
```bash
git add PKGBUILD .SRCINFO gamevault.desktop
git commit -m "Release v1.3.0"
git push origin master
```

---

## Installing (For Users)

### Via AUR Helper:
```bash
yay -S gamevault-bin
# or
paru -S gamevault-bin
```

### Manual Installation:
```bash
git clone https://aur.archlinux.org/gamevault-bin.git
cd gamevault-bin
makepkg -si
```
