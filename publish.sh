#!/usr/bin/env sh
# Publish the version already set in package.json, from a clean, tested tree.
set -eu

if [ -n "$(git status --porcelain)" ]; then
	echo "Working tree is not clean; commit or stash first." >&2
	exit 1
fi

npm test
npm run test:types

version=$(node -p "require('./package.json').version")
npm publish
git tag -m "$version" "v$version"
git push --follow-tags
