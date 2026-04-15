-- Inner-project file. It shows the name of the working folder of the server
-- that elaborates it: `"inner"` for the server of the inner project.
#eval (do return (← IO.currentDir).fileName.getD "" : IO String)
