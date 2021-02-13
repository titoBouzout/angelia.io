@RD /S /Q ..\\client\\node_modules\\angelia.io
@RD /S /Q ..\\server\\node_modules\\angelia.io
mkdir ..\\client\\node_modules\\angelia.io
mkdir ..\\server\\node_modules\\angelia.io
xcopy .\\ ..\\client\\node_modules\\angelia.io /y /s /e /q
xcopy .\\ ..\\server\\node_modules\\angelia.io /y /s /e /q
type nul > ..\\server\\restart

exit
