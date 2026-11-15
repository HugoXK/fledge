The CI restore drill now reuses the build artifact instead of installing dependencies and compiling a second time, and refuses any artifact whose manifest does not name the commit under test.
