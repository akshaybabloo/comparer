use slint::{Brush, Color, ModelRc, SharedString, VecModel};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::rc::Rc;

slint::include_modules!();

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    // Initialize our shared text model with the default data
    let syntax_model = Rc::new(VecModel::from(vec![
        SyntaxText { text: SharedString::from("First Line"), color: Brush::SolidColor(Color::from_rgb_u8(255, 255, 255)), background: Brush::SolidColor(Color::from_rgb_u8(0, 0, 0)) },
        SyntaxText { text: SharedString::from("Second Line"), color: Brush::SolidColor(Color::from_rgb_u8(255, 255, 255)), background: Brush::SolidColor(Color::from_rgb_u8(0, 0, 0)) },
    ]));
    
    ui.set_syntax_text(ModelRc::from(syntax_model.clone()));

    // Clone model reference for inside the move closure
    let syntax_model_clone = syntax_model.clone();

    ui.on_file_dropped(move |data_transfer, side| {
        println!("File dropped on the {} pane", side.as_str());

        if let Ok(text_payload) = data_transfer.plain_text() {
            for line in text_payload.lines() {
                // Strip OS file:// prefix and handle standard URL encoding if present
                let raw_path = line.trim_start_matches("file://");
                let clean_path = match urlencoding::decode(raw_path) {
                    Ok(decoded) => decoded.into_owned(),
                    Err(_) => raw_path.to_string(),
                };

                // Attempt to open and read lines from the file
                if let Ok(file) = File::open(&clean_path) {
                    let reader = BufReader::new(file);
                    
                    for text_line in reader.lines().map_while(Result::ok) {
                        // Create item explicitly marked with a solid white brush
                        let new_item = SyntaxText {
                            text: SharedString::from(text_line),
                            color: Brush::SolidColor(Color::from_rgb_u8(255, 255, 255)),
                            background: Brush::SolidColor(Color::from_rgb_u8(0, 0, 0)),
                        };
                        syntax_model_clone.push(new_item);
                    }
                } else {
                    eprintln!("Failed to open file: {}", clean_path);
                }
            }
        }
    });

    ui.run()
}
