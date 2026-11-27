# GameVault privacy policy

_Last updated: 27 November 2026_

GameVault is a game launcher and library for your PC. Everything works without an account, and your library stays on your PC. This page covers what GameVault sends to its server, and what happens when you sign in to the optional GameVault account (GameVault Cloud).

## Without an account

To fill in artwork, wishlist prices and the lines on your Peak games, GameVault asks its server about a game by its name or store ID (and your country, for prices). These lookups carry no account and aren't tied to you. Your playtime, sessions, notes and file paths never leave your PC unless you sign in and turn on library sync.

## What we store when you sign in

- **Your account:** your email address, and your name and profile picture if you sign in with Google. Used only to sign you in.
- **Your library, if you turn on "Sync my library":** your games, playtime, play sessions, status, ratings and notes. **Never** your file paths, install folders or API keys.
- **Your game saves, if you turn on "Back up my game saves":** the save files of the games you choose. They are packed and encrypted on your PC before upload. We keep the latest 3 backups per game.
- **Artwork lookups:** game names or Steam IDs you look up artwork for, so the shared artwork cache can answer faster for everyone. These are not tied to your name.

## What we don't do

- We don't sell or share your data with anyone.
- We don't show ads or track you across other apps or sites.
- We don't read your files beyond the save folders you pick.

## Where it lives

Data is stored with [Supabase](https://supabase.com) (servers in the EU, Frankfurt). Google sign-in is handled by Google; GameVault only receives your name, email and profile picture.

## Your choices

- Turn either cloud feature off at any time in **Settings → Account & cloud**.
- Delete individual save backups in **Settings → Backups**.
- Delete your account and everything stored with it in **Settings → Account & cloud → Delete account**. If that fails, open an issue at [github.com/itzSornet/Gamevault/issues](https://github.com/itzSornet/Gamevault/issues) and it will be removed by hand.

## Changes

If this policy changes, the new version is published here with a new date.
