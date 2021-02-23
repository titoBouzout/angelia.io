
cd ..
CMD /C npm link

cd ../client/
CMD /C npm link angelia.io

cd ../server/
CMD /C npm link angelia.io

cd ../angelia.io
CMD /C npm install

exit