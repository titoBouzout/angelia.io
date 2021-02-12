call npm version minor

git add --all
git commit -m "update"

git push --all --prune

call npm publish
