# GameVault pacman repository

Static pacman repository served from this branch via GitHub Pages.

```
https://itzsornet.github.io/Gamevault/x86_64
```

## Layout

```
x86_64/
  gamevault.db                                  # repo database (pacman fetches this)
  gamevault.files                               # file lists
  gamevault-<version>-1-x86_64.pkg.tar.zst      # package
```

## Installing (users)

```bash
echo -e '\n[gamevault]\nServer = https://itzsornet.github.io/Gamevault/x86_64\nSigLevel = Optional TrustAll' | sudo tee -a /etc/pacman.conf
sudo pacman -Syu
sudo pacman -S gamevault
```

## Publishing a new version (maintainer)

From a clean checkout of the repo:

```bash
cd packaging/pacman
makepkg -f                       # builds gamevault-<ver>-1-x86_64.pkg.tar.zst
```

Then, in a fresh `gh-pages` working copy:

```bash
git clone --depth 1 -b gh-pages git@github.com:itzSornet/Gamevault.git pages
cd pages
rm -f x86_64/gamevault-*                       # drop the previous version
cp ~/path/to/gamevault-<ver>-1-x86_64.pkg.tar.zst x86_64/
cd x86_64
repo-add gamevault.db.tar.zst gamevault-<ver>-1-x86_64.pkg.tar.zst
cp --remove-destination gamevault.db.tar.zst gamevault.db
cp --remove-destination gamevault.files.tar.zst gamevault.files
rm -f gamevault.db.tar.zst gamevault.files.tar.zst
cd ..
git add -A && git commit -m "repo: gamevault <ver>"
git push -f origin gh-pages
```

Force-pushing a fresh commit each release keeps the branch at one commit so the
~86 MB package is not accumulated in history.

## Notes

- Not GPG-signed. If this repo ever serves more than your own builds, generate a
  key, sign the database, publish the key in the PKGBUILD (`validpgpkeys`) and set
  `SigLevel = Required DatabaseOptional` in the client config.
- GitHub Pages limits: 1 GB site, 100 MB per file — the package is ~86 MB, so keep
  only the current version in the branch.
